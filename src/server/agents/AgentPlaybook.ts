import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AgentStrategyProfile } from "./AgentTypes";

export const openFrontAgentPlaybook = [
  "ProxyWar priorities: expand territory, preserve enough troops to defend, build economy, then attack only when the target is weak or strategically exposed.",
  "Early game: claim nearby neutral land, avoid thin borders, build the first City safely inside owned territory, and build Ports on coast or Factories inland when affordable.",
  "Combat: prefer weak bordered targets, use modest troop percentages unless clearly stronger, avoid attacking allies, and avoid opening several risky wars at once.",
  "Defense: use Defense Posts near vulnerable borders, keep gold for emergency structures, and do not spend all troops while exposed.",
  "Diplomacy: alliances secure flanks; donations help allies only when they remain useful and not threatening.",
  "Late economy: ports, factories, and cities compound income and troop generation; avoid sitting at troop cap with no expansion plan.",
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
