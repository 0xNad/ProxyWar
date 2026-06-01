export const proxyWarPublicRunArtifacts = [
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

export const proxyWarPublicTournamentArtifacts = [
  "leaderboard.html",
  "leaderboard.json",
  "tournament-report.md",
] as const;

export const proxyWarPublicDocs = [
  "PROXYWAR_EXTERNAL_AGENT_API.md",
  "PROXYWAR_TESTER_HANDOFF.md",
  "BETA_TESTER_GUIDE.md",
  "PROXYWAR_ASSET_AND_LICENSE_AUDIT.md",
] as const;

export const proxyWarPublicExternalAgentExamples = [
  "README.md",
  "simple-agent.mjs",
  "starter-framework.mjs",
  "agent-policy.mjs",
  "manifest.example.json",
  "package.json",
  "launch.sh",
  ".env.example",
  "LICENSE",
  "PROXYWAR_AGENT_CARD.md",
  "AGENT_SKILL.md",
] as const;

export function isProxyWarPublicRunArtifact(fileName: string): boolean {
  return (proxyWarPublicRunArtifacts as readonly string[]).includes(fileName);
}

export function isProxyWarPublicTournamentArtifact(fileName: string): boolean {
  return (proxyWarPublicTournamentArtifacts as readonly string[]).includes(
    fileName,
  );
}

export function isProxyWarPublicDoc(fileName: string): boolean {
  return (proxyWarPublicDocs as readonly string[]).includes(fileName);
}

export function isProxyWarPublicExternalAgentExample(
  fileName: string,
): boolean {
  return (
    proxyWarPublicExternalAgentExamples as readonly string[]
  ).includes(fileName);
}

export function isSafeProxyWarArtifactSegment(value: string): boolean {
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
