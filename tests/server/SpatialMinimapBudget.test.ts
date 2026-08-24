import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import {
  createAgentSpatialSnapshot,
  SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES,
} from "../../src/server/agents/AgentSpatialObservation";
import type { AgentSpatialMinimap } from "../../src/server/agents/AgentTypes";
import { setup } from "../util/Setup";

const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#";

describe("spatial minimap serialization boundary", () => {
  it("fits 25 exact IDs by omitting redundant names rather than truncating identity", async () => {
    const playerInfos = Array.from({ length: 25 }, (_, index) => {
      const ordinal = index.toString().padStart(7, "0");
      const seat = (index + 1).toString().padStart(2, "0");
      return new PlayerInfo(
        `Candidate Seat ${seat} NNNNNNNNN`,
        PlayerType.Human,
        `C${ordinal}`,
        `P${ordinal}`,
      );
    });
    expect(new Set(playerInfos.map((player) => player.id.length))).toEqual(
      new Set([8]),
    );
    expect(new Set(playerInfos.map((player) => player.name.length))).toEqual(
      new Set([27]),
    );

    const game = await setup("plains", { nations: "disabled" }, playerInfos);
    for (let index = 0; index < playerInfos.length; index++) {
      game.player(playerInfos[index].id).conquer(game.ref(index + 1, 1));
    }
    while (game.inSpawnPhase()) game.executeNextTick();
    const base = createAgentSpatialSnapshot(game, true).minimap;
    expect(base).toBeDefined();
    const minimap: AgentSpatialMinimap = {
      schemaVersion: 2,
      width: base!.width,
      height: base!.height,
      ownershipRows: [...base!.ownershipRows],
      terrainRows: [...base!.terrainRows],
      legend: base!.legend.map((entry) => ({
        ...entry,
        isYou: entry.playerID === playerInfos[0].id,
      })),
      markers: base!.markers.map((marker) => ({ ...marker })),
      markersTotal: base!.markersTotal,
      markersReturned: base!.markers.length,
      markersTruncated: base!.markers.length < base!.markersTotal,
    };

    expect(minimap.legend.map((entry) => entry.playerID)).toEqual(
      playerInfos.map((player) => player.id),
    );
    expect(minimap.legend.map((entry) => entry.glyph).join("")).toBe(
      GLYPHS.slice(0, 25),
    );
    expect(minimap.legend.every((entry) => !Object.hasOwn(entry, "name"))).toBe(
      true,
    );

    expect(
      Buffer.byteLength(JSON.stringify(minimap), "utf8"),
    ).toBeLessThanOrEqual(SPATIAL_MINIMAP_SERIALIZED_MAX_BYTES);
  });
});
