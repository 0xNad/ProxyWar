export const openFrontierPublicRunArtifacts = [
  "game-record.json",
  "decisions.jsonl",
  "match-summary.json",
  "match-package.json",
  "match-package.html",
  "match-package.md",
  "spectator-replay.json",
  "spectator-telemetry.json",
  "visual-report.html",
  "spectator.html",
  "objective-scorecard.md",
  "match-story.md",
  "behavior-quality-report.json",
  "behavior-quality-report.md",
  "external-agent-feedback.md",
] as const;

export const openFrontierPublicTournamentArtifacts = [
  "leaderboard.html",
  "leaderboard.json",
  "tournament-report.md",
] as const;

export const openFrontierPublicDocs = [
  "OPEN_FRONTIER_START_HERE.md",
  "OPEN_FRONTIER_EXTERNAL_AGENT_API.md",
  "OPEN_FRONTIER_OPERATOR_RUNBOOK.md",
  "BETA_TESTER_GUIDE.md",
  "REMOTE_FRIENDS_BETA.md",
] as const;

export const openFrontierPublicExternalAgentExamples = [
  "README.md",
  "simple-agent.mjs",
  "starter-framework.mjs",
  "agent-policy.mjs",
  "manifest.example.json",
  "package.json",
  ".env.example",
  "LICENSE",
  "OPEN_FRONTIER_AGENT_CARD.md",
  "AGENT_SKILL.md",
] as const;

export function isOpenFrontierPublicRunArtifact(fileName: string): boolean {
  return (openFrontierPublicRunArtifacts as readonly string[]).includes(fileName);
}

export function isOpenFrontierPublicTournamentArtifact(fileName: string): boolean {
  return (openFrontierPublicTournamentArtifacts as readonly string[]).includes(
    fileName,
  );
}

export function isOpenFrontierPublicDoc(fileName: string): boolean {
  return (openFrontierPublicDocs as readonly string[]).includes(fileName);
}

export function isOpenFrontierPublicExternalAgentExample(
  fileName: string,
): boolean {
  return (
    openFrontierPublicExternalAgentExamples as readonly string[]
  ).includes(fileName);
}

export function isSafeOpenFrontierArtifactSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    value !== "." &&
    value !== ".." &&
    value === pathBasename(value) &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  );
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/).pop() ?? "";
}
