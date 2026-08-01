import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEventPackageDraft } from "../../src/scripts/premiere-package";
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
    expect(draft.title).toBe("Auri vs Sefirot");
    expect(draft.mapLabel).toBe("Pangaea");
    expect(draft.format).toBe("2p duel");
    expect(draft.canonicalMatchUrl).toBe(`/match/${FEAT_ID}`);
    expect(draft.canonicalPremiereUrl).toContain("/premiere/");
    expect(draft.embargoState).toBe("embargoed");
    expect(draft.createdAt).toBe(NOW);
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
});
