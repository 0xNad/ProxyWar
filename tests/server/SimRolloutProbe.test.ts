import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it } from "vitest";
import { Difficulty, GameMapSize, GameMapType, GameMode, GameType } from "../../src/core/game/Game";
import { GameMapLoader, MapData } from "../../src/core/game/GameMapLoader";
import { createGameRunner } from "../../src/core/GameRunner";
import { MapManifest } from "../../src/core/game/TerrainMapLoader";
import { evaluateCommitments, GameSnapshot, RolloutAgentSeat } from "../../src/server/agents/SimRollout";

class Loader implements GameMapLoader {
  maps = new Map<GameMapType, MapData>();
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../resources/maps");
  getMapData(map: GameMapType): MapData {
    const c=this.maps.get(map); if(c) return c;
    const dir=path.join(this.root, Object.keys(GameMapType).find(k=>GameMapType[k as keyof typeof GameMapType]===map)!.toLowerCase());
    const d={mapBin:()=>fs.promises.readFile(path.join(dir,"map.bin")),map4xBin:()=>fs.promises.readFile(path.join(dir,"map4x.bin")),map16xBin:()=>fs.promises.readFile(path.join(dir,"map16x.bin")),manifest:()=>fs.promises.readFile(path.join(dir,"manifest.json"),"utf8").then(t=>JSON.parse(t) as MapManifest),webpPath:path.join(dir,"thumbnail.webp")} satisfies MapData;
    this.maps.set(map,d); return d;
  }
}
function info(){return {gameID:"P",lobbyCreatedAt:0,config:{gameMap:GameMapType.Pangaea,gameMapSize:GameMapSize.Compact,gameMode:GameMode.FFA,gameType:GameType.Singleplayer,difficulty:Difficulty.Medium,nations:"disabled",bots:0,donateGold:false,donateTroops:false,infiniteGold:false,infiniteTroops:false,instantBuild:false,randomSpawn:false,disabledUnits:[],maxPlayers:4},players:[{clientID:"A",username:"A",clanTag:null},{clientID:"B",username:"B",clanTag:null}]} as any;}

async function build(gap:number, rivalSpawnDelay:number, growTicks:number): Promise<{snap:GameSnapshot,rivalID:string,agentTiles:number,rivalTiles:number,border:boolean}>{
  const r=await createGameRunner(info(),undefined,new Loader(),()=>undefined);
  const m=r.game.map();
  const land=(x:number,y:number)=>{for(let rad=0;rad<60;rad++)for(let dx=-rad;dx<=rad;dx++)for(let dy=-rad;dy<=rad;dy++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=m.width()||ny>=m.height())continue;const ref=m.ref(nx,ny);if(m.isLand(ref))return ref;}throw new Error("no land");};
  const cx=Math.floor(m.width()/2),cy=Math.floor(m.height()/2);
  const aT=land(cx-gap,cy),bT=land(cx+gap,cy);
  const turns:any[]=[{turnNumber:0,intents:[]}];
  turns.push({turnNumber:1,intents:[{type:"spawn",tile:aT,clientID:"A"}]});
  // rival spawns later (weaker)
  for(let t=2;t<2+rivalSpawnDelay;t++) turns.push({turnNumber:t,intents:[]});
  turns.push({turnNumber:2+rivalSpawnDelay,intents:[{type:"spawn",tile:bT,clientID:"B"}]});
  let tn=3+rivalSpawnDelay;
  for(let t=0;t<growTicks;t++) turns.push({turnNumber:tn++,intents:[]});
  for(const t of turns) r.addTurn(t);
  while(r.pendingTurns()>0) r.executeNextTick(r.pendingTurns());
  const A=r.game.playerByClientID("A")!,B=r.game.playerByClientID("B")!;
  return {snap:{gameStartInfo:info(),turns},rivalID:B.id(),agentTiles:A.numTilesOwned(),rivalTiles:B.numTilesOwned(),border:A.sharesBorderWith(B)};
}
const seats:RolloutAgentSeat[]=[{clientID:"A",profile:"aggressive"},{clientID:"B",profile:"defensive"}];
describe("probe2",()=>{
  it("rollout discrimination across constructions",async()=>{
    for (const [gap,delay,grow,horizon] of [[1,0,200,3],[1,40,200,6],[1,80,300,8],[2,60,300,8]] as const){
      const {snap,rivalID,agentTiles,rivalTiles,border}=await build(gap,delay,grow);
      const loader=new Loader();
      const ranked=await evaluateCommitments({snapshot:snap,mapLoader:loader,agentClientID:"A",commitments:[
        {id:"press",objective:"pressure_rival",targetPlayerId:rivalID,troopRatio:0.6},
        {id:"ghost",objective:"pressure_rival",targetPlayerId:"nope",troopRatio:0.6},
        {id:"fort",objective:"fortify_border",targetPlayerId:null},
      ],agents:seats,config:{horizonSteps:horizon}});
      const p=ranked.find(f=>f.commitmentId==="press")!,g=ranked.find(f=>f.commitmentId==="ghost")!,f=ranked.find(f=>f.commitmentId==="fort")!;
      console.error(`gap=${gap} delay=${delay} grow=${grow} h=${horizon} | A=${agentTiles} B=${rivalTiles} border=${border} || press(td=${p.tileDelta},cf=${p.contestedFrontDelta},os=${p.outcomeScore}) ghost(td=${g.tileDelta},os=${g.outcomeScore}) fort(td=${f.tileDelta},os=${f.outcomeScore})`);
    }
  },300000);
});
