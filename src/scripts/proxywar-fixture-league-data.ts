/**
 * Writes the Stage 8 fixture identity registry + league mirror site
 * (data.json / read-model.json / index.html) to a fixture root — the
 * "identity + league mirror" half of `run-public-product-fixtures.sh`'s
 * orchestration. Never touches the tracked `resources/identity/*.json`
 * files: it writes to `<root>/identity/`, which the demo server only ever
 * reads from when explicitly pointed there via
 * `PROXYWAR_IDENTITY_REGISTRY_DIR` (see `IdentityRegistry.ts`'s doc).
 *
 * Usage:
 *   tsx src/scripts/proxywar-fixture-league-data.ts --root=<dir> \
 *     [--drama-episode-file=<path to a JSON CoworldLeagueEpisodeRow>] \
 *     [--premiere-upcoming-file=<path to a JSON CoworldLeaguePremiereCard>] \
 *     [--latest-premiere-file=<path to a JSON CoworldLeagueLatestPremiereCard>]
 *
 * The drama/premiere inputs are FILES rather than inline flags because they
 * carry real (if small) structured JSON the orchestrating shell script
 * assembles from a real local match / real premiere admission — passing
 * them as files avoids any shell quoting hazard.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  saveAgentRegistry,
  saveAgentVersionRegistry,
  saveBuilderRegistry,
} from "../server/identity/IdentityRegistry";
import {
  DEGRADED_EPISODE,
  FIXTURE_AGENTS,
  FIXTURE_BUILDERS,
  FIXTURE_VERSIONS,
  ORDINARY_EPISODE,
  fixtureLeagueMirrorData,
} from "../server/fixtures/PublicProductFixtureData";
import { writeCoworldLeagueSite } from "../server/agents/CoworldLeagueSiteWriter";
import type {
  CoworldLeagueEpisodeRow,
  CoworldLeagueLatestPremiereCard,
  CoworldLeaguePremiereCard,
} from "../server/agents/CoworldLeagueSiteWriter";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function readJsonFileIfPresent<T>(
  filePath: string | undefined,
): Promise<T | undefined> {
  if (filePath === undefined) return undefined;
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function main(): Promise<void> {
  const root = argValue("root");
  if (root === undefined) {
    throw new Error("--root=<fixture-root-dir> is required");
  }
  const resolvedRoot = path.resolve(root);
  const identityDir = path.join(resolvedRoot, "identity");
  const artifactsDir = path.join(resolvedRoot, "artifacts");
  const leagueSiteDir = path.join(artifactsDir, "ai-league-runs", "league");

  await fs.mkdir(identityDir, { recursive: true });
  await saveBuilderRegistry(
    [...FIXTURE_BUILDERS],
    path.join(identityDir, "builders.json"),
  );
  await saveAgentRegistry(
    [...FIXTURE_AGENTS],
    path.join(identityDir, "agents.json"),
  );
  await saveAgentVersionRegistry(
    [...FIXTURE_VERSIONS],
    path.join(identityDir, "versions.json"),
  );
  console.log(`fixture identity registry written: ${identityDir}`);

  const dramaEpisode = await readJsonFileIfPresent<CoworldLeagueEpisodeRow>(
    argValue("drama-episode-file"),
  );
  const premiere = await readJsonFileIfPresent<CoworldLeaguePremiereCard>(
    argValue("premiere-upcoming-file"),
  );
  const latestPremiere =
    await readJsonFileIfPresent<CoworldLeagueLatestPremiereCard>(
      argValue("latest-premiere-file"),
    );

  // `ORDINARY_EPISODE` itself stays honest (`watchHref: null` — a pure
  // data fixture has no filesystem access to back a real link with real
  // bytes; see its own doc comment). THIS script, unlike that data file,
  // actually writes artifacts to disk, so it can honestly promote the
  // link to a real one by writing the self-contained spectator page the
  // href points at — same pattern production uses
  // (`coworld-league-mirror.ts`'s `/ai-league-runs/<key>/spectator.html`,
  // served statically by `ai-agent-demo-server.ts`), just hand-authored
  // instead of unpacked from a real replay. A shallow copy, never a
  // mutation of the shared exported constant other consumers rely on.
  // `league-` prefixed: `isProxyWarPublicLeaguePath`'s allowlist (checked
  // by the leagueWrapperOnly gate in `ai-agent-demo-server.ts`, the mode
  // every fixture/production league deployment actually runs in) only
  // lets `/ai-league-runs/<key>/...` through for `league-*` keys — the
  // exact same prefix `coworld-league-mirror.ts`'s real
  // `publicRunKey = \`league-${replay.runID}\`` always applies. Omitting
  // it 404s with "AI league replay record not found." before the file
  // is ever looked up, confirmed live.
  const ordinaryRunKey = "league-fixture-ordinary-0001";
  const ordinarySpectatorDir = path.join(
    artifactsDir,
    "ai-league-runs",
    ordinaryRunKey,
  );
  await fs.mkdir(ordinarySpectatorDir, { recursive: true });
  await fs.writeFile(
    path.join(ordinarySpectatorDir, "spectator.html"),
    "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\">" +
      "<title>Iron Vanguard vs House Keystone — Proxy War fixture replay</title>" +
      "</head><body><h1>Iron Vanguard vs House Keystone</h1>" +
      "<p>Fixture spectator page for episodeRequestId=" +
      ORDINARY_EPISODE.episodeRequestId +
      ". This fixture episode has no real replay bytes (see " +
      "PublicProductFixtureData.ts's ORDINARY_EPISODE doc comment); this " +
      "static page exists only so the /watch archive card's link " +
      "genuinely resolves end to end in tests.</p></body></html>",
  );
  const ordinaryEpisodeWithWatchHref: CoworldLeagueEpisodeRow = {
    ...ORDINARY_EPISODE,
    watchHref: `/ai-league-runs/${ordinaryRunKey}/spectator.html`,
  };

  const episodes: CoworldLeagueEpisodeRow[] = [
    ordinaryEpisodeWithWatchHref,
    DEGRADED_EPISODE,
  ];
  if (dramaEpisode !== undefined) {
    episodes.unshift(dramaEpisode);
  }

  const mirrorData = fixtureLeagueMirrorData({
    episodes,
    premiere,
    latestPremiere,
  });

  await fs.mkdir(leagueSiteDir, { recursive: true });
  const paths = await writeCoworldLeagueSite(leagueSiteDir, mirrorData);
  console.log(`fixture league mirror site written: ${JSON.stringify(paths)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
