import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AgentStrategyProfile } from "./AgentTypes";

export const openFrontAgentPlaybook = [
  "Proxy War priorities: expand territory, preserve enough troops to defend, build economy, then attack only when the target is weak or strategically exposed.",
  "Early game: claim nearby neutral land, avoid thin borders, build the first City safely inside owned territory, and build Ports on coast or Factories inland when affordable.",
  "Combat: prefer weak bordered targets, use modest troop percentages unless clearly stronger, avoid attacking allies, and avoid opening several risky wars at once.",
  "Defense: use Defense Posts near vulnerable borders, keep gold for emergency structures, and do not spend all troops while exposed.",
  "Diplomacy: alliances secure flanks; donations help allies only when they remain useful and not threatening. Use embargo to choke a rival's gold, target_player to mark a focus rival, and break_alliance to betray an ally when betrayal clearly converts to a winning position (ally early, betray late and decisively).",
  "Late economy: ports, factories, and cities compound income and troop generation; avoid sitting at troop cap with no expansion plan. When neutral land runs low or you hold a strong economy, invest gold in the tech tree instead of only expanding.",
  "Full arsenal — build the tech tree and use it when the board calls for it, do not only expand and attack: Ports create trade income and enable coastal assault via Transport boats; Warships (built from a Port onto nearby water) patrol the sea to sink enemy transports, capture trade ships, and screen your own landings, and move_warship repositions their patrol for free; Missile Silos unlock nuclear strikes (Atom Bomb / Hydrogen Bomb / MIRV) to break a dominant rival, crack a fortified border, or end a stalemate; SAM Launchers shoot down incoming nukes. Build a Port and a Missile Silo once your economy can afford them, and reach for transports, warships, nukes, and SAM defense when a rival is too strong, too fortified, or threatening you with nukes.",
].join("\n");

/**
 * Compact economy-and-deterrence facts (K3 of plan keen-sparking-hollerith). The
 * verified failure mode behind gold starvation: agents buy 50k Defense Posts instead
 * of banking the 125k first City, income never compounds, and the 1M silo / 1.5M SAM /
 * 25M MIRV tree stays permanently unaffordable — so these facts state the causal
 * chain and the price list explicitly. Shared vocabulary: included in the LLM
 * action-selector prompt (LlmPromptBuilder) and mirrored in
 * skills/FrontierAgent/SKILL.md, which the Commander planner prompt embeds.
 */
export const economyDeterrencePlaybook = [
  "ECONOMY & DETERRENCE: Income compounds only through structures — Cities raise income and max troops, Factories multiply nearby City output (build them adjacent), and Ports add sea-trade gold. Bank the 125k first-City cost early instead of spending 50k on precautionary Defense Posts; an economy started late never catches up.",
  "A Missile Silo (1M gold) UNLOCKS nukes: nuclear strikes physically require an active silo, so no silo means no nuclear option ever. A SAM Launcher (1.5M, ~70-tile auto-intercept umbrella) protects your City/Factory/Port/silo cluster — without one, a single enemy nuke erases the economy. A MIRV (~25M) guts a runaway leader before the win timer.",
  "When land is tight, UPGRADE existing Cities/Factories/Ports/silos in place instead of sprawling new buildings. Gold sitting above ~3M is a wasted weapon: spend it on structures, upgrades, silos, or SAM cover — or, once a silo stands, bank deliberately toward nukes and the MIRV.",
].join("\n");

export function profilePlaybook(profile: AgentStrategyProfile): string {
  switch (profile) {
    case "aggressive":
      return "Aggressive skill: expand or attack to keep momentum; prefer weak bordered targets, neutral expansion, and pressure actions, but do not suicide into stronger armies.";
    case "defensive":
      return "Defensive skill: secure borders first; prefer Defense Posts on vulnerable edges, safe Cities/Factories, alliances, and small expansions over risky wars.";
    case "diplomatic":
      return "Diplomatic skill: secure flanks with alliances, support useful allies, build economy, and use embargo or attacks only when diplomacy is unavailable or a target is clearly unsafe to leave alone.";
    case "opportunistic":
      return "Opportunistic skill: take low-risk growth whenever available; prefer neutral expansion, affordable economy, and weak targets, otherwise wait.";
  }
}

export const frontierAgentSkill = loadFrontierAgentSkill();

function loadFrontierAgentSkill(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "skills/FrontierAgent/SKILL.md"),
    path.resolve(moduleDir, "../../../skills/FrontierAgent/SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch {
      // Skill text is best-effort so tests and package builds can run from
      // alternate working directories.
    }
  }
  return [
    "# FrontierAgent",
    "Always choose one offered LegalAction.id. Never invent intents.",
    "Prefer useful non-hold actions, preserve reserves, expand safely, build economy, use diplomacy, retreat bad attacks, and finish leaders with legal pressure.",
  ].join("\n");
}
