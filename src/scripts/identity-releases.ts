import { loadAgentVersionRegistry, defaultAgentVersionRegistryPath } from "../server/identity/IdentityRegistry";
import {
  mutateVersionReleaseStore,
  readVersionReleaseStore,
  resolveVersionReleaseStateRoot,
  type PendingVersionRelease,
} from "../server/platform/PlatformVersionReleaseStore";
import { reconcilePendingReleases } from "../server/identity/VersionReleaseReconcile";

/**
 * `identity:releases` — the operator/CI-facing half of Season Zero Phase
 * 6's builder-improvement loop. Two subcommands:
 *
 *   identity:releases list [--status pending]
 *   identity:releases reconcile [--data-json <path>] [--dir <registryDir>]
 *
 * `list` reads the release store (state root resolved the same way as
 * every other platform store — `PROXYWAR_VERSION_RELEASE_STATE_ROOT`, see
 * `resolveVersionReleaseStateRoot`) and prints every release notice,
 * optionally filtered to one `status`.
 *
 * `reconcile` runs `VersionReleaseReconcile.ts`'s pure matching against
 * the ALREADY-SYNCED `AgentVersion` registry and writes any newly
 * `observed` releases back. `--data-json` is accepted and intentionally
 * ignored: it exists purely so an operator's runbook can document "run
 * this after `sync-version-registry.ts <data-json>`" without a confusing
 * unused-flag error, but the matching itself only needs the version
 * REGISTRY (already synced by that separate step) — `sync-version-
 * registry.ts` is the sole owner of deriving `firstObservedAt` from raw
 * mirror data, and this CLI never re-derives it.
 */

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function runList(argv: readonly string[]): Promise<void> {
  const statusFilter = flagValue(argv, "--status");
  const stateRoot = resolveVersionReleaseStateRoot();
  const file = await readVersionReleaseStore(stateRoot);
  const releases =
    statusFilter === undefined
      ? file.releases
      : file.releases.filter((release) => release.status === statusFilter);
  console.log(`identity:releases list — ${releases.length} release(s)`);
  for (const release of releases) {
    console.log(
      `${release.id} ${release.status} agent=${release.agentId} version=${release.versionLabel} observedVersionId=${release.observedVersionId ?? "-"}`,
    );
  }
}

async function runReconcile(argv: readonly string[]): Promise<void> {
  const dir = flagValue(argv, "--dir");
  // Accepted for runbook forward-compat ("run this after
  // sync-version-registry.ts <data-json>") but never read: matching only
  // needs the already-synced AgentVersion registry, not the raw mirror
  // data — see this module's doc.
  void flagValue(argv, "--data-json");

  const versionRegistryPath = defaultAgentVersionRegistryPath(dir);
  const observedVersions = await loadAgentVersionRegistry(versionRegistryPath);
  const stateRoot = resolveVersionReleaseStateRoot();

  let newlyObserved: readonly PendingVersionRelease[] = [];
  await mutateVersionReleaseStore(stateRoot, (file) => {
    const previousStatusById = new Map(
      file.releases.map((release) => [release.id, release.status]),
    );
    const { updated, changed } = reconcilePendingReleases(
      file.releases,
      observedVersions,
    );
    if (!changed) return file;
    newlyObserved = updated.filter(
      (release) =>
        release.status === "observed" &&
        previousStatusById.get(release.id) !== "observed",
    );
    return { ...file, releases: [...updated] };
  });

  if (newlyObserved.length === 0) {
    console.log("identity:releases reconcile — no newly observed releases");
    return;
  }
  for (const release of newlyObserved) {
    console.log(
      `${release.id} observed as ${release.observedVersionId} (first observed ${release.observedAt})`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (subcommand === "list") {
    await runList(argv.slice(1));
    return;
  }
  if (subcommand === "reconcile") {
    await runReconcile(argv.slice(1));
    return;
  }
  console.error(
    "usage: identity:releases <list|reconcile> [--status <status>] [--dir <registryDir>] [--data-json <path>]",
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
