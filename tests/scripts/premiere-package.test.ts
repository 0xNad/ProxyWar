import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEventPackageDraft } from "../../src/scripts/premiere-package";
import { isPubliclyPromotable } from "../../src/server/agents/season/EventPackageGate";
import type { FeaturedMatch } from "../../src/server/agents/FeaturedMatch";
import type { EventPackage } from "../../src/server/agents/season/EventPackage";
import type { IdentityRegistrySnapshot } from "../../src/server/identity/IdentityRegistry";
import type { CoworldLeagueMirrorData } from "../../src/server/agents/CoworldLeagueSiteWriter";

const FEAT_ID = `feat_${"c".repeat(20)}`;
const NOW = "2026-08-01T00:00:00.000Z";

function baseMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: FEAT_ID,
    lane: "premiere",
    episodeRequestId: "ereq_x",
    queueItemName: "20260801T000000Z-run1",
    title: "Auri vs Sefirot",
    description: "",
    participants: [],
    map: "Pangaea",
    format: "2p duel",
    provenance: { source: "premiere-queue", sourceRef: "20260801T000000Z-run1", capturedAt: NOW },
    state: "published",
    category: null,
    scheduledAt: "2026-08-08T18:00:00.000Z",
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: 10000,
      decisionCount: null,
      degradedCount: 0,
      seatCount: 2,
      replayComplete: true,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function identity(): IdentityRegistrySnapshot {
  return { builders: [], agents: [], versions: [] };
}

describe("buildEventPackageDraft", () => {
  it("generates a fresh draft with structural fields derived from the match", () => {
    const draft = buildEventPackageDraft(baseMatch(), null, identity(), null, NOW);
    expect(draft.featuredMatchId).toBe(FEAT_ID);
    // baseMatch() has zero participants (see this file's other "zero
    // participants" comment) — the spoiler-neutral title generator
    // (2026-08-01 P0) falls back to map/format, same shape as
    // defaultSubtitle, rather than blindly copying match.title.
    expect(draft.title).toBe("Pangaea — 2p duel");
    expect(draft.mapLabel).toBe("Pangaea");
    expect(draft.format).toBe("2p duel");
    expect(draft.canonicalMatchUrl).toBe(`/match/${FEAT_ID}`);
    expect(draft.canonicalPremiereUrl).toContain("/premiere/");
    expect(draft.embargoState).toBe("embargoed");
    expect(draft.createdAt).toBe(NOW);
  });

  it("generates a spoiler-neutral title from participants + map when a lineup exists, never from match.title", () => {
    const match = baseMatch({
      title: "Auri wins — Pangaea duel", // a spoiler-laden match.title must NEVER leak through
      participants: [
        { playerName: "Auri", agentId: "agt_auri", agentVersionId: null, builderId: null },
        { playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: null, builderId: null },
      ],
    });
    const draft = buildEventPackageDraft(match, null, identity(), null, NOW);
    expect(draft.title).toBe("Auri vs Sefirot — Pangaea");
    expect(draft.title).not.toContain("wins");
  });

  it("falls back to a participant count for a large lineup rather than an unreadable name list", () => {
    const match = baseMatch({
      participants: Array.from({ length: 12 }, (_, index) => ({
        playerName: `Player${index}`,
        agentId: null,
        agentVersionId: null,
        builderId: null,
      })),
    });
    const draft = buildEventPackageDraft(match, null, identity(), null, NOW);
    expect(draft.title).toBe("12-way battle — Pangaea");
  });

  it("never sets a canonical premiere URL for an archive-lane match", () => {
    const match = baseMatch({
      lane: "archive",
      state: "published",
      scheduledAt: null,
      queueItemName: null,
      provenance: { source: "league-archive", sourceRef: "ereq_x", capturedAt: NOW },
    });
    const draft = buildEventPackageDraft(match, null, identity(), null, NOW);
    expect(draft.canonicalPremiereUrl).toBeNull();
  });

  it("marks embargoState revealed once the match has actually revealed", () => {
    const draft = buildEventPackageDraft(baseMatch({ state: "revealed" }), null, identity(), null, NOW);
    expect(draft.embargoState).toBe("revealed");
  });

  it("preserves operator-edited prose across a regeneration unless a new override is passed", () => {
    const existing: EventPackage = {
      schemaVersion: 1,
      featuredMatchId: FEAT_ID,
      title: "Operator's own title",
      subtitle: "Operator's own subtitle",
      reasonToWatch: { claims: [] },
      mapLabel: "Pangaea",
      format: "2p duel",
      scheduledAt: "2026-08-08T18:00:00.000Z",
      directorCutEstimateSeconds: null,
      canonicalMatchUrl: `/match/${FEAT_ID}`,
      canonicalPremiereUrl: "/premiere/xyz",
      embargoState: "embargoed",
      editorialNotes: "hand-written note",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const draft = buildEventPackageDraft(baseMatch(), existing, identity(), null, NOW);
    expect(draft.title).toBe("Operator's own title");
    expect(draft.subtitle).toBe("Operator's own subtitle");
    expect(draft.editorialNotes).toBe("hand-written note");
    expect(draft.createdAt).toBe("2026-07-30T00:00:00.000Z");
    expect(draft.updatedAt).toBe(NOW);
  });

  it("an explicit override wins over both the existing package and the match default", () => {
    const draft = buildEventPackageDraft(baseMatch(), null, identity(), null, NOW, {
      titleOverride: "New Operator Title",
    });
    expect(draft.title).toBe("New Operator Title");
  });

  it("reads the Director Cut estimate from the mirror's matching episode row", () => {
    const mirror = {
      episodes: [
        { episodeRequestId: "ereq_x", directorCut: { durationEstimateSeconds: 420, segmentCount: 6 } },
      ],
    } as unknown as CoworldLeagueMirrorData;
    const draft = buildEventPackageDraft(baseMatch(), null, identity(), mirror, NOW);
    expect(draft.directorCutEstimateSeconds).toBe(420);
  });

  it("leaves the Director Cut estimate null when no matching episode/plan exists yet", () => {
    const draft = buildEventPackageDraft(baseMatch(), null, identity(), null, NOW);
    expect(draft.directorCutEstimateSeconds).toBeNull();
  });

  it("rejects a package whose title/subtitle names the winner once the match carries a result", () => {
    const match = baseMatch({
      lane: "archive",
      title: "Auri wins — Pangaea duel",
      participants: [
        { playerName: "Auri", agentId: "agt_auri", agentVersionId: null, builderId: null },
        { playerName: "Sefirot", agentId: "agt_sefirot", agentVersionId: null, builderId: null },
      ],
      result: { winnerAgentId: "agt_auri", placements: [{ agentId: "agt_auri", placement: 1 }] },
    });
    const draft = buildEventPackageDraft(match, null, identity(), null, NOW, {
      titleOverride: "Auri wins — Pangaea duel",
    });
    expect(isPubliclyPromotable(match, draft).missing).toContain("title_spoils_result");
  });
});

/**
 * Real subprocess (`tsx`) end-to-end coverage of the `premiere:package`
 * entry point itself — argv parsing, env-based root resolution, and the
 * real `isMainModule` dispatch — matching `premiere-schedule-cli.test.ts`'s
 * own established pattern for this repo's operator CLIs.
 */
describe("premiere:package CLI — real subprocess end to end", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const scriptPath = path.join(repoRoot, "src", "scripts", "premiere-package.ts");

  let featuredMatchStateRoot: string;
  let artifactsRoot: string;

  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("npx", ["tsx", scriptPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PROXYWAR_FEATURED_MATCH_STATE_ROOT: featuredMatchStateRoot,
          PROXYWAR_EVENT_PACKAGE_STATE_ROOT: featuredMatchStateRoot,
          PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
          PROXYWAR_IDENTITY_REGISTRY_DIR: artifactsRoot,
        },
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status: number; stdout: Buffer; stderr: Buffer };
      return { code: err.status, stdout: err.stdout?.toString("utf8") ?? "", stderr: err.stderr?.toString("utf8") ?? "" };
    }
  }

  beforeEach(async () => {
    featuredMatchStateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-package-state-"));
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-package-artifacts-"));
    // Minimal empty tracked-identity-shaped registry so loadIdentityRegistrySnapshot
    // succeeds against this throwaway directory rather than the real repo one.
    await writeFile(path.join(artifactsRoot, "builders.json"), JSON.stringify({ schemaVersion: 1, builders: [] }), "utf8");
    await writeFile(path.join(artifactsRoot, "agents.json"), JSON.stringify({ schemaVersion: 1, agents: [] }), "utf8");
    await writeFile(path.join(artifactsRoot, "versions.json"), JSON.stringify({ schemaVersion: 1, versions: [] }), "utf8");
    await writeFile(
      path.join(featuredMatchStateRoot, "featured-matches.json"),
      JSON.stringify({ schemaVersion: 1, matches: [baseMatch()] }),
      "utf8",
    );
  });

  afterEach(async () => {
    await Promise.all([featuredMatchStateRoot, artifactsRoot].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("generates and saves a package, then reports completeness", () => {
    const result = runCli([`--featured=${FEAT_ID}`]);
    expect(result.stdout).toContain("event package saved");
    expect(result.stdout).toContain("isPubliclyPromotable");
  });

  it("errors clearly for an unknown featured match id", () => {
    const result = runCli([`--featured=feat_${"9".repeat(20)}`]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("featured match not found");
  });

  it("--validate refuses to run before a package has ever been generated", () => {
    const result = runCli([`--featured=${FEAT_ID}`, "--validate"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no event package exists yet");
  });

  it("--validate reports non-zero exit for an incomplete package (missing participants)", async () => {
    runCli([`--featured=${FEAT_ID}`]);
    const validated = runCli([`--featured=${FEAT_ID}`, "--validate"]);
    // baseMatch() has zero participants, so the gate can never pass.
    expect(validated.code).not.toBe(0);
    expect(validated.stdout).toContain("participants");
  }, 30000);

  it("warns (non-blocking) when an explicit --title= override names the winner", async () => {
    await writeFile(
      path.join(featuredMatchStateRoot, "featured-matches.json"),
      JSON.stringify({
        schemaVersion: 1,
        matches: [
          baseMatch({
            lane: "archive",
            scheduledAt: null,
            queueItemName: null,
            provenance: { source: "league-archive", sourceRef: "ereq_x", capturedAt: NOW },
            participants: [
              { playerName: "Auri", agentId: "agt_auri", agentVersionId: null, builderId: null },
            ],
            result: { winnerAgentId: "agt_auri", placements: [{ agentId: "agt_auri", placement: 1 }] },
          }),
        ],
      }),
      "utf8",
    );
    const result = runCli([`--featured=${FEAT_ID}`, `--title=Auri wins the Pangaea duel`]);
    expect(result.code).toBe(0); // never blocking at the CLI-warning level
    expect(result.stdout).toContain("event package saved");
    expect(result.stdout).toContain("prose warnings (not blocking):");
    expect(result.stdout).toContain("title names the winner");
  });
});
