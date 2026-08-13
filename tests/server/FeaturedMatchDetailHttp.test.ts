/**
 * Full-replay-access bugfix (2026-08-05): `GET /api/featured-matches/:matchId`
 * — the narrow route `/match/:matchId` (MatchDetailPage.ts) fetches for a
 * `FeaturedMatch` (`feat_...`) record, reached in production via the
 * homepage/`/watch` Season Zero schedule and any revealed/archived
 * Premiere. Before this fix the route never loaded the live mirror at
 * all, so `watchHref`/`fullRenderHref` silently came back `null`
 * regardless of what the mirror actually had, leaving that page with no
 * way to watch the match it was reporting a result for.
 *
 * Boots a REAL demo server (same binary production runs, same
 * `spawn`+`tsx` pattern `ProxyWarLeagueUpdateHttp.test.ts`/
 * `BetOriginLeagueMirrorRedirect.test.ts` already use for this same
 * module) against a minimal fixture: a real `episodeRequestId`-linked
 * mirror episode (`ai-league-runs/league/data.json`, with distinct
 * `watchHref`/`fullRenderHref`) and a matching `FeaturedMatch` record
 * (`featured-matches.json`) using realistic, non-colliding `feat_...`/
 * `ereq_...` ids — never the same string, exactly like production.
 * Asserts the OBSERVABLE HTTP response contract, not any internal
 * plumbing. The pure-function null-propagation branches (`episodeRequestId`
 * null, mirror totally absent) are already covered at the unit level in
 * `ProxyWarPublicReadModel.test.ts`/`LeaguePlayerProfile.test.ts`; this
 * file adds exactly one additional real-HTTP case — an `episodeRequestId`
 * that never reached the mirror — to prove the ROUTE itself degrades to
 * `null` rather than erroring, without re-deriving every lower-level
 * branch through a live server boot.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readCoworldLeagueRetentionPinManifest } from "../../src/server/agents/CoworldLeagueArtifactRetention";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);

const MIRRORED_MATCH_ID = "feat_0000000000000000cafe";
const MIRRORED_EPISODE_REQUEST_ID = "ereq_real_episode_42";
const UNMIRRORED_MATCH_ID = "feat_00000000000000001eaf";
const UNMIRRORED_EPISODE_REQUEST_ID = "ereq_never_reached_mirror";
// Full-replay-retention fix (2026-08-06): a THIRD record whose episode is
// deliberately absent from `data.json`'s live `episodes[]` (simulating
// mirror-window rotation, not "never reached the mirror" like
// UNMIRRORED_* above) but whose durable compact-evidence archive (written
// by the pruner BEFORE it would ever delete the raw/rendered artifacts)
// IS present under `artifacts/coworld-league-mirror/summaries/` — proving
// the narrow route's archive fallback, not just the live-mirror path.
const ROTATED_MATCH_ID = "feat_00000000000000002bad";
const ROTATED_EPISODE_REQUEST_ID = "ereq_rotated_out_episode";
const ROTATED_RUN_ID = "coworld-2026-07-30T00-00-00-000Z-rotated1";
const ROTATED_PUBLIC_RUN_KEY = `league-${ROTATED_RUN_ID}`;
const RAW_CACHE_EPISODE_REQUEST_ID = "ereq_raw_cache_only_episode";
const RAW_CACHE_RUN_ID = "coworld-2026-07-30T01-00-00-000Z-rawcache1";
const RAW_CACHE_PUBLIC_RUN_KEY = `league-${RAW_CACHE_RUN_ID}`;
const UNKNOWN_PUBLIC_RUN_KEY =
  "league-coworld-2026-07-30T00-00-00-000Z-unknown9";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("GET /api/featured-matches/:matchId resolves the live mirror's watchHref/fullRenderHref by episodeRequestId", () => {
  let fixtureRoot = "";
  let privateStateRoot = "";
  let featuredMatchStateRoot = "";
  let artifactsRoot = "";
  let summariesRoot = "";
  let pinManifestPath = "";
  let server: ChildProcess | null = null;
  let origin = "";
  let serverOutput = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-featured-match-http-")),
    );
    // A SEPARATE root, never nested under fixtureRoot — the server's own
    // cwd carries no `artifacts/` directory at all, matching production
    // (PROXYWAR_ARTIFACTS_ROOT points elsewhere entirely from the deploy
    // worktree's own cwd; see FeaturedMatchRetentionPin.ts's own doc for
    // why this distinction matters for retention-pin resolution).
    artifactsRoot = await realpath(
      await mkdtemp(
        path.join(tmpdir(), "proxywar-featured-match-http-artifacts-"),
      ),
    );
    const homeRoot = path.join(fixtureRoot, "home");
    const nationsRoot = path.join(fixtureRoot, "nations");
    const staticRoot = path.join(fixtureRoot, "static");
    const identityDir = path.join(fixtureRoot, "identity");
    summariesRoot = path.join(
      artifactsRoot,
      "coworld-league-mirror",
      "summaries",
    );
    const runsRoot = path.join(artifactsRoot, "ai-league-runs");
    const leagueRoot = path.join(runsRoot, "league");
    const replayCacheRoot = path.join(
      artifactsRoot,
      "coworld-league-mirror",
      "replays",
    );
    privateStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-premiere-state`,
    );
    featuredMatchStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-featured-matches`,
    );
    pinManifestPath = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-retention-pins.json`,
    );

    await Promise.all([
      mkdir(homeRoot, { recursive: true }),
      mkdir(nationsRoot, { recursive: true }),
      mkdir(staticRoot, { recursive: true }),
      mkdir(identityDir, { recursive: true }),
      mkdir(leagueRoot, { recursive: true }),
      mkdir(replayCacheRoot, { recursive: true }),
      mkdir(path.join(runsRoot, RAW_CACHE_PUBLIC_RUN_KEY), { recursive: true }),
      mkdir(summariesRoot, { recursive: true }),
      mkdir(path.join(fixtureRoot, "resources", "lang"), { recursive: true }),
      mkdir(privateStateRoot, { recursive: true }),
      mkdir(featuredMatchStateRoot, { recursive: true }),
    ]);
    await chmod(privateStateRoot, 0o700);

    await Promise.all([
      writeFile(
        path.join(fixtureRoot, "index.html"),
        "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
        "utf8",
      ),
      writeFile(
        path.join(staticRoot, "index.html"),
        "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
        "utf8",
      ),
      writeFile(
        path.join(staticRoot, "public.html"),
        '<!doctype html><html><head><title>Proxy War</title><meta name="description" content="Proxy War"><script>window.GIT_COMMIT = <%- gitCommit %>;</script></head><body>PUBLIC APP</body></html>',
        "utf8",
      ),
      writeFile(
        path.join(leagueRoot, "index.html"),
        "<!doctype html><html><body>PROXY WAR league</body></html>",
        "utf8",
      ),
      writeFile(
        path.join(fixtureRoot, "resources", "lang", "en.json"),
        "{}",
        "utf8",
      ),
      writeFile(
        path.join(identityDir, "builders.json"),
        JSON.stringify({ schemaVersion: 1, builders: [] }),
        "utf8",
      ),
      writeFile(
        path.join(identityDir, "agents.json"),
        JSON.stringify({ schemaVersion: 1, agents: [] }),
        "utf8",
      ),
      writeFile(
        path.join(identityDir, "versions.json"),
        JSON.stringify({ schemaVersion: 1, versions: [] }),
        "utf8",
      ),
      // The real mirror episode the MIRRORED_MATCH_ID record spotlights —
      // kept under its OWN real ereq_ id, exactly like production
      // (`publicMatch()`, `ProxyWarPublicReadModel.ts`) — with distinct
      // watchHref (lightweight spectator schematic) and fullRenderHref
      // (the real full replay renderer) so the two are never confused.
      writeFile(
        path.join(leagueRoot, "data.json"),
        JSON.stringify({
          generatedAt: "2026-07-29T00:00:00.000Z",
          lastGoodSyncAt: "2026-07-29T00:00:00.000Z",
          stale: false,
          standings: [],
          episodes: [
            {
              episodeRequestId: MIRRORED_EPISODE_REQUEST_ID,
              roundNumber: 42,
              completedAt: "2026-07-29T00:00:00.000Z",
              map: "Pangaea",
              turnCount: 4000,
              winnerName: null,
              watchHref:
                "/ai-league-runs/league-real-episode-42/spectator.html",
              fullRenderHref: "/ai-league-replay/league-real-episode-42",
              players: [],
            },
          ],
        }),
        "utf8",
      ),
      // Full-replay-retention fix (2026-08-06): the durable compact-evidence
      // archive for ROTATED_EPISODE_REQUEST_ID — written the way the REAL
      // pruner writes it (`CoworldLeagueArtifactRetention.ts`'s
      // `archivePlans`), deliberately with NO corresponding entry in
      // `data.json`'s `episodes[]` above (simulating an episode that has
      // aged out of the live mirror window after being archived).
      writeFile(
        path.join(
          summariesRoot,
          `${ROTATED_EPISODE_REQUEST_ID}.replay-summary.json.gz`,
        ),
        gzipSync(
          JSON.stringify({
            episodeRequestId: ROTATED_EPISODE_REQUEST_ID,
            runID: ROTATED_RUN_ID,
            matchID: "COWRLD01",
            gameID: "COWRLD01",
            config: {
              map: "BlackSea",
              map_size: "Normal",
            },
            results: {
              winner_slot: 1,
              turn_count: 4200,
              decision_count: 88,
              degraded_count: 3,
              players: [
                {
                  slot: 0,
                  name: "Ari Sklar",
                  tiles_owned: 123,
                  is_alive: true,
                },
                {
                  slot: 1,
                  name: "Matt Van",
                  tiles_owned: 456,
                  is_alive: true,
                },
              ],
            },
          }),
        ),
      ),
      writeFile(
        path.join(replayCacheRoot, `${RAW_CACHE_EPISODE_REQUEST_ID}.replay`),
        JSON.stringify({
          runID: RAW_CACHE_RUN_ID,
          config: { map: "Asia", map_size: "Normal" },
          results: {
            winner_slot: 0,
            players: [
              {
                slot: 0,
                name: "Raw Cache Winner",
                tiles_owned: 500,
                is_alive: true,
              },
            ],
          },
        }),
      ),
      writeFile(
        path.join(runsRoot, RAW_CACHE_PUBLIC_RUN_KEY, "game-record.json"),
        JSON.stringify({ info: { gameID: "raw-cache-test" }, turns: [] }),
      ),
      // The byte-faithful `game-record.json` archive `/ai-league-replay/:runID`
      // itself needs to actually render — a real GameRecordSchema-shaped
      // `turns` array, not the `{ compacted: true }` stub.
      writeFile(
        path.join(
          summariesRoot,
          `${ROTATED_PUBLIC_RUN_KEY}.game-record.json.gz`,
        ),
        gzipSync(
          JSON.stringify({
            info: { gameID: "rotated-test" },
            version: 1,
            turns: [{ tick: 1 }],
          }),
        ),
      ),
      // Three archive-lane FeaturedMatch records, realistic non-colliding
      // feat_/ereq_ ids: one whose episodeRequestId resolves against the
      // live mirror episode above, one whose episodeRequestId never
      // reached it, and one whose episode rotated OUT of the mirror but
      // is durably archived (see the two gzip writes above).
      writeFile(
        path.join(featuredMatchStateRoot, "featured-matches.json"),
        JSON.stringify({
          schemaVersion: 1,
          matches: [
            {
              schemaVersion: 1,
              matchId: MIRRORED_MATCH_ID,
              lane: "archive",
              episodeRequestId: MIRRORED_EPISODE_REQUEST_ID,
              queueItemName: null,
              title: "Recent Archive Spotlight",
              description: "A great battle.",
              participants: [],
              map: "Pangaea",
              format: "1v1",
              provenance: {
                source: "league-archive",
                sourceRef: MIRRORED_EPISODE_REQUEST_ID,
                capturedAt: "2026-07-29T00:00:00.000Z",
              },
              state: "archived",
              category: null,
              scheduledAt: null,
              revealAt: null,
              evidence: {
                dramaScore: null,
                dramaGrade: null,
                entertainmentScore: null,
                storyGrade: null,
                turnCount: null,
                decisionCount: null,
                degradedCount: null,
                seatCount: null,
                replayComplete: true,
                notes: [],
              },
              postMatchSummary: "A great battle.",
              result: { winnerAgentId: null, placements: [] },
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
            },
            {
              schemaVersion: 1,
              matchId: UNMIRRORED_MATCH_ID,
              lane: "archive",
              episodeRequestId: UNMIRRORED_EPISODE_REQUEST_ID,
              queueItemName: null,
              title: "Not Yet Mirrored",
              description: "",
              participants: [],
              map: "Pangaea",
              format: "1v1",
              provenance: {
                source: "league-archive",
                sourceRef: UNMIRRORED_EPISODE_REQUEST_ID,
                capturedAt: "2026-07-29T00:00:00.000Z",
              },
              state: "archived",
              category: null,
              scheduledAt: null,
              revealAt: null,
              evidence: {
                dramaScore: null,
                dramaGrade: null,
                entertainmentScore: null,
                storyGrade: null,
                turnCount: null,
                decisionCount: null,
                degradedCount: null,
                seatCount: null,
                replayComplete: true,
                notes: [],
              },
              postMatchSummary: null,
              result: { winnerAgentId: null, placements: [] },
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
            },
            {
              schemaVersion: 1,
              matchId: ROTATED_MATCH_ID,
              lane: "archive",
              episodeRequestId: ROTATED_EPISODE_REQUEST_ID,
              queueItemName: null,
              title: "Rotated Out Of The Mirror",
              description: "",
              participants: [],
              map: "Pangaea",
              format: "1v1",
              provenance: {
                source: "league-archive",
                sourceRef: ROTATED_EPISODE_REQUEST_ID,
                capturedAt: "2026-07-25T00:00:00.000Z",
              },
              state: "archived",
              category: null,
              scheduledAt: null,
              revealAt: null,
              evidence: {
                dramaScore: null,
                dramaGrade: null,
                entertainmentScore: null,
                storyGrade: null,
                turnCount: null,
                decisionCount: null,
                degradedCount: null,
                seatCount: null,
                replayComplete: true,
                notes: [],
              },
              postMatchSummary: null,
              result: { winnerAgentId: null, placements: [] },
              createdAt: "2026-07-25T00:00:00.000Z",
              updatedAt: "2026-07-25T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      ),
    ]);

    const port = await reservePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--tsconfig",
        path.join(projectRoot, "tsconfig.json"),
        path.join(projectRoot, "src", "scripts", "ai-agent-demo-server.ts"),
      ],
      {
        cwd: fixtureRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: homeRoot,
          NODE_ENV: "test",
          GAME_ENV: "dev",
          AI_LEAGUE_DEMO_HOST: "127.0.0.1",
          AI_LEAGUE_DEMO_PORT: String(port),
          AI_LEAGUE_DEMO_RENDERER: "false",
          PROXYWAR_BETA_ENABLED: "false",
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
          PROXYWAR_CLIPS_ENABLED: "false",
          PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
          PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
          PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
          PROXYWAR_NATIONS_DIR: nationsRoot,
          PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
          PROXYWAR_FEATURED_MATCH_STATE_ROOT: featuredMatchStateRoot,
          PROXYWAR_IDENTITY_REGISTRY_DIR: identityDir,
          PROXYWAR_LEAGUE_RETENTION_PINS: pinManifestPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    await waitForServer(origin, () => serverOutput, server);
  }, 30_000);

  afterAll(async () => {
    await stopServer(server);
    if (fixtureRoot !== "")
      await rm(fixtureRoot, { recursive: true, force: true });
    if (artifactsRoot !== "")
      await rm(artifactsRoot, { recursive: true, force: true });
    if (privateStateRoot !== "")
      await rm(privateStateRoot, { recursive: true, force: true });
    if (featuredMatchStateRoot !== "")
      await rm(featuredMatchStateRoot, { recursive: true, force: true });
    await rm(pinManifestPath, { force: true });
  });

  test("carries the mirror episode's exact watchHref/fullRenderHref for a matched episodeRequestId", async () => {
    const response = await rawRequest(
      origin,
      `/api/featured-matches/${encodeURIComponent(MIRRORED_MATCH_ID)}`,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      schemaVersion: number;
      match: {
        matchId: string;
        state: string;
        watchHref: string | null;
        fullRenderHref: string | null;
      };
    };
    expect(body.match.matchId).toBe(MIRRORED_MATCH_ID);
    expect(body.match.state).toBe("archived");
    expect(body.match.watchHref).toBe(
      "/ai-league-runs/league-real-episode-42/spectator.html",
    );
    expect(body.match.fullRenderHref).toBe(
      "/ai-league-replay/league-real-episode-42",
    );
  });

  test("reports null (never fabricated) watchHref/fullRenderHref when the record's episodeRequestId never reached the mirror; no retention pin is fabricated for it either (manifest file need not even exist yet)", async () => {
    const response = await rawRequest(
      origin,
      `/api/featured-matches/${encodeURIComponent(UNMIRRORED_MATCH_ID)}`,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      match: {
        matchId: string;
        watchHref: string | null;
        fullRenderHref: string | null;
      };
    };
    expect(body.match.matchId).toBe(UNMIRRORED_MATCH_ID);
    expect(body.match.watchHref).toBeNull();
    expect(body.match.fullRenderHref).toBeNull();

    // readCoworldLeagueRetentionPinManifest is ENOENT-tolerant (returns an
    // empty manifest) so this assertion holds regardless of whether an
    // earlier test in this file has already created the pin file.
    const manifest =
      await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(
      manifest.pins.some(
        (pin) => pin.episodeRequestId === UNMIRRORED_EPISODE_REQUEST_ID,
      ),
    ).toBe(false);
  });

  test("full-replay-retention fix (2026-08-06): falls back to the durable archive for a matchId whose episode rotated OUT of the live mirror window — fullRenderHref resolves, watchHref stays null, AND the exact retention pin is added even though the server's own cwd has no artifacts/ (production incident regression: options.artifactsRoot must reach computeFeaturedMatchPinAddOperation)", async () => {
    const response = await rawRequest(
      origin,
      `/api/featured-matches/${encodeURIComponent(ROTATED_MATCH_ID)}`,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      match: {
        matchId: string;
        watchHref: string | null;
        fullRenderHref: string | null;
      };
    };
    expect(body.match.matchId).toBe(ROTATED_MATCH_ID);
    expect(body.match.watchHref).toBeNull();
    expect(body.match.fullRenderHref).toBe(
      `/ai-league-replay/${ROTATED_PUBLIC_RUN_KEY}`,
    );

    // The pin manifest must carry the exact owner entry — before the fix,
    // this file stayed byte-identical (0 pins added) even though the href
    // above resolved correctly, exactly as the production incident
    // reported (archive-href writer/app gates passed, pin gate failed).
    const manifest =
      await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toContainEqual({
      episodeRequestId: ROTATED_EPISODE_REQUEST_ID,
      publicRunKey: ROTATED_PUBLIC_RUN_KEY,
      reason: `featured-match:${ROTATED_MATCH_ID}`,
    });
  });

  test("full-replay-retention fix: GET /ai-league-replay/:runID lazily restores a missing live game-record.json from its durable archive and serves 200", async () => {
    const liveGameRecordPath = path.join(
      artifactsRoot,
      "ai-league-runs",
      ROTATED_PUBLIC_RUN_KEY,
      "game-record.json",
    );
    // Proves this is genuinely a RESTORE, not a pre-existing live file.
    await expect(readFile(liveGameRecordPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const response = await rawRequest(
      origin,
      `/ai-league-replay/${encodeURIComponent(ROTATED_PUBLIC_RUN_KEY)}`,
    );
    expect(response.status).toBe(200);

    // The archive itself must be untouched (read-only) — same bytes as the
    // fixture wrote, still present.
    const archivePath = path.join(
      summariesRoot,
      `${ROTATED_PUBLIC_RUN_KEY}.game-record.json.gz`,
    );
    const archivedGameRecord = JSON.parse(
      gunzipSync(await readFile(archivePath)).toString("utf8"),
    );
    // The restored live file now exists and matches the archive exactly —
    // a real, valid, renderable GameRecord, not a stub or partial write.
    const restoredGameRecord = JSON.parse(
      await readFile(liveGameRecordPath, "utf8"),
    );
    expect(restoredGameRecord).toEqual(archivedGameRecord);
    expect(restoredGameRecord.turns).toEqual([{ tick: 1 }]);
  });

  test("ordinary match lookup survives live-window rotation by reconstructing its public row from the durable archive", async () => {
    const response = await rawRequest(
      origin,
      `/api/matches/${encodeURIComponent(ROTATED_EPISODE_REQUEST_ID)}`,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      match: {
        episodeRequestId: string;
        roundNumber: number | null;
        completedAt: string | null;
        map: string;
        mapSize: string;
        turnCount: number | null;
        decisionCount: number | null;
        degradedCount: number | null;
        winnerName: string | null;
        watchHref: string | null;
        fullRenderHref: string | null;
        players: Array<{ name: string; placement: number; isWinner: boolean }>;
      };
    };
    expect(body.match).toMatchObject({
      episodeRequestId: ROTATED_EPISODE_REQUEST_ID,
      roundNumber: null,
      completedAt: null,
      map: "BlackSea",
      mapSize: "Normal",
      turnCount: 4200,
      decisionCount: 88,
      degradedCount: 3,
      winnerName: "Matt Van",
      watchHref: null,
      fullRenderHref: `/ai-league-replay/${ROTATED_PUBLIC_RUN_KEY}`,
    });
    expect(body.match.players).toEqual([
      expect.objectContaining({
        name: "Matt Van",
        placement: 1,
        isWinner: true,
      }),
      expect.objectContaining({
        name: "Ari Sklar",
        placement: 2,
        isWinner: false,
      }),
    ]);
  });

  test("ordinary match HTML, metadata, and share card remain available after live-window rotation", async () => {
    const page = await rawRequest(
      origin,
      `/match/${encodeURIComponent(ROTATED_EPISODE_REQUEST_ID)}`,
    );
    expect(page.status, serverOutput).toBe(200);
    expect(page.body).toContain("PUBLIC APP");
    expect(page.body).toContain("Ari Sklar vs Matt Van — BlackSea");
    expect(page.body).toContain(
      `/match/${encodeURIComponent(ROTATED_EPISODE_REQUEST_ID)}/card-v1.svg`,
    );

    const card = await rawRequest(
      origin,
      `/match/${encodeURIComponent(ROTATED_EPISODE_REQUEST_ID)}/card-v1.svg`,
    );
    expect(card.status).toBe(200);
    expect(card.headers["content-type"]).toContain("image/svg+xml");
    expect(card.body).toContain("Matt Van");
  });

  test("ordinary match lookup uses the retained raw cache before a compact summary exists", async () => {
    const response = await rawRequest(
      origin,
      `/api/matches/${encodeURIComponent(RAW_CACHE_EPISODE_REQUEST_ID)}`,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      match: {
        episodeRequestId: RAW_CACHE_EPISODE_REQUEST_ID,
        map: "Asia",
        winnerName: "Raw Cache Winner",
        fullRenderHref: `/ai-league-replay/${RAW_CACHE_PUBLIC_RUN_KEY}`,
      },
    });
  });

  test("full-replay-retention fix: GET /ai-league-replay/:runID for a run with NO archive evidence still redirects to /league, unchanged", async () => {
    const response = await rawRequest(
      origin,
      `/ai-league-replay/${encodeURIComponent(UNKNOWN_PUBLIC_RUN_KEY)}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/league");
    await expect(
      readFile(
        path.join(
          artifactsRoot,
          "ai-league-runs",
          UNKNOWN_PUBLIC_RUN_KEY,
          "game-record.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (server === null || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => server.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function reservePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") {
    listener.close();
    throw new Error("Failed to reserve a local HTTP port");
  }
  await new Promise<void>((resolve, reject) =>
    listener.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
  return address.port;
}

async function waitForServer(
  baseUrl: string,
  output: () => string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early:\n${output()}`);
    }
    try {
      const response = await rawRequest(baseUrl, "/league");
      if (response.status === 200) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server:\n${output()}`);
}

async function rawRequest(
  baseUrl: string,
  requestPath: string,
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
        headers: { accept: "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}
