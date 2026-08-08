/**
 * Coworld episode artifacts that may be served without application-layer
 * authorization. Keep this a subset of the canonical
 * `proxyWarPublicRunArtifacts` list; the parity test fails if the two public
 * contracts diverge. Raw decisions and visual reports are intentionally absent.
 */
export const coworldPublicRunArtifacts = [
  "game-record.json",
  "deal-ledger.json",
  "match-summary.json",
  "match-package.json",
  "match-package.html",
  "match-package.md",
  "spectator-replay.json",
  "spectator-telemetry.json",
  "spectator.html",
  "objective-scorecard.md",
  "match-story.md",
  "behavior-quality-report.json",
  "behavior-quality-report.md",
  "external-agent-feedback.md",
] as const;
