# Trusted-contributor merge and Coworld deployment

ProxyWar automatically admits pull requests authored by the exact GitHub logins
`johomax` and `relh`, then batches eligible admitted merges after a 15-minute
quiet window into one immutable `proxywar` Coworld version. The live target is
the existing Proxy War league; the automation never creates another league.

## Trust boundary

`.github/automation/trusted-release-policy.json` is the auditable source of the
allowlist, required checks, blocking labels, protected paths, pinned Coworld
CLI version, and expected league ID. Author identity always comes from
`pull_request.user.login`. Labels, commit authors, email addresses, display
names, fork names, and branch names are not authority.

The privileged `🔐 Trusted PR admission` workflow checks out protected `main`
only. It never checks out a pull-request head or merge ref and never downloads
or executes pull-request artifacts. Compilation and tests remain in ordinary
read-only `pull_request` and `merge_group` CI jobs.

Changes to workflows, the allowlist/policy, admission or release scripts,
credential handling, and automation tests require an `APPROVED` review from
`0xNad` on the exact head SHA. Normal game, UI, replay-viewer, commissioner,
manifest, and league fixes remain eligible without that exception.

## Merge behavior

The repository is user-owned, so GitHub merge queues are unavailable. The
supported fallback is protected `main` with strict required checks and
conversation resolution. Admission re-fetches the PR and exact head, then uses
GitHub's atomic `mergePullRequest(expectedHeadOid: ...)` mutation. This avoids
the clean-PR rejection in `enablePullRequestAutoMerge` and makes a changed head
fail rather than race. Repository auto-merge remains enabled for ordinary
operator use but is not an authorization mechanism.

GitHub suppresses most recursive events created with `GITHUB_TOKEN`. Admission
therefore mints a short-lived installation token from the dedicated trusted
release GitHub App. The App token lets an otherwise-safe trusted PR branch be
updated to current `main` at an exact expected head SHA while still triggering
ordinary read-only pull-request CI. No branch update occurs with the fallback
`GITHUB_TOKEN`; admission reports the missing App token and fails closed. After
an exact-head merge, admission writes a bot-authored queue issue from the
returned merge SHA and explicitly dispatches the production worker. Each issue
is a durable per-PR audit record, not necessarily a separate package. The worker
waits until no newer eligible merge has arrived for 15 minutes, snapshots every
open queue record, orders them by each PR's live authoritative `merged_at`, and
snapshots protected current `main` as the release source only after proving it
contains every queued merge. Using current `main` prevents an older held queue
record from ever downgrading a newer canonical release. GitHub concurrency is
only a single-worker lock; the issue ledger and quiet-window snapshot define the
durable batch.

The repository-level GitHub App configuration is:

- variable `TRUSTED_RELEASE_APP_CLIENT_ID` — the App's non-secret client ID;
- secret `TRUSTED_RELEASE_APP_PRIVATE_KEY` — the App private key;
- installation scope — only `0xNad/ProxyWar`;
- repository permissions — Actions read/write, Checks read, Contents
  read/write, Issues read/write, Metadata read, Pull requests read/write, and
  Workflows write.

The App requires no webhook and no production or Coworld credential. Its token
is minted for one job, explicitly narrowed to `ProxyWar`, masked by Actions,
and revoked by the token action after the job.

## Coworld production pipeline

`🌍 Coworld production` runs only from protected `main` and accesses the
`coworld-production` environment. It:

1. revalidates every included queue issue, trusted author, tested head, merge
   SHA, labels, changed paths, required owner approval, merge order, and ancestry;
2. waits for complete CI on the protected `main` snapshot SHA, explicitly
   dispatching the exact-source CI fallback if a token-created merge suppressed
   `push`;
3. allocates the next hosted version on a fresh protected-code-only runner and
   persists the original rollback target in the durable queue record;
4. runs focused replay tests, typechecks, commissioner tests, the memory gate,
   image builds, manifest checks, and local certification on a separate runner
   that never receives production credentials;
5. transfers only a checksummed archive whose tar members, provenance, version,
   and manifest artifact references are validated on a fresh production
   runner; runs `coworld list` immediately before upload and safely retries the
   still-open oldest queue item after any allocation collision;
6. always builds from
   `coworld-adapter/coworld/coworld_manifest_template.json`, whose replay bundle
   is the local `build/static-replay-viewer` hook, never a downloaded hosted
   manifest or `sha256:` substitution;
7. stamps the exact source plus all included PR numbers, queue records, merge
   SHAs, and the main-CI run into the hosted manifest's release-provenance page;
8. uploads with hosted smoke and full certification waits, requiring all ten
   certification steps;
9. verifies canonical state, the existing league binding, a completed hosted
   smoke episode and replay bytes, then executes the published viewer in an
   isolated Chrome session and requires a canvas plus numeric replay progress;
10. creates one GitHub deployment record and job summary, then comments on every
    included PR and closes every included durable queue record with the previous
    canonical package retained.

The Coworld toolchain is pinned to `coworld==0.1.38`. The required environment
secret is:

- `COWORLD_API_TOKEN` — a Softmax **user** credential with Coworld upload rights.

The token is passed only to fresh protected-code-only preflight/deploy runners.
The wrapper creates a random credential home for one allowlisted network
command, removes the token from the child environment, and deletes the home in
a `finally` block. Contributor code, dependencies, Docker hooks, build hooks,
and local certification execute on another runner and can never access the
token. Credentials never enter artifacts, logs, summaries, comments, or
deployments.

## Current Coworld promotion limitation

Coworld `0.1.38` exposes upload, status, and certification APIs but no separate
canonical-promotion or rollback operation. Upload auto-promotes the package;
the full hosted certification wait is observational after upload. Local
certification and hosted smoke therefore remain preconditions, but a later
hosted-certification or post-promotion verification failure cannot be rolled
back automatically through the current public API. The workflow fails loudly,
keeps every historical package, records both new and previous IDs, and never
claims the release healthy. When Softmax exposes staged promotion/rollback, the
release policy already has tested `leave-previous`, `promote`, and `rollback`
decision branches ready to bind to that API.

## Repository configuration

`main` must require these exact contexts with strict up-to-date branches:

- `🏗️ Build`
- `🔬 Test (1/4)` through `🔬 Test (4/4)`
- `🔬 Test (heavy: agent-league-match)`
- `🔬 Test (e2e)`
- `🔍 ESLint`
- `🎨 Prettier`
- `🗺️ Generated maps up to date`
- `🐳 Docker build (root image, build stage)`
- 🚫 No Open&#32;Frontier residue
- `🔐 Trusted release automation`

The inherited `🎨 Prettier` job is guarded to the upstream
`openfrontio/OpenFrontIO` repository. Its existing `skipped` conclusion is the
only non-`success` required-check conclusion admitted; all other contexts must
complete with `success` from the GitHub Actions App.

Conversation resolution is required. Force pushes and deletion of `main` are
disabled. Auto-merge is enabled. The `coworld-production` environment permits
deployments from `main` only and has no human approval gate; terminal Coworld
certification is the deployment gate.

The inherited OpenFront deploy and release workflows remain intentionally
inactive because every job is guarded by
`github.repository == 'openfrontio/OpenFrontIO'`. They deploy OpenFront hosts
and images using upstream-only infrastructure and are not the ProxyWar Coworld
release path.
