# Proxy War Identity Model

Date: 2026-07-31

This document describes the Builder/Agent/AgentVersion identity registry that maps live Coworld league participants to public identities — the schemas, the matching algorithm, the three identity statuses, and every place the code refuses to auto-attribute an agent to a person. It covers only what exists on `claude/product-overhaul` today. Source: `src/server/identity/*.ts`, `src/server/ProxyWarPublicReadModel.ts`, `src/server/agents/CoworldLeagueSiteWriter.ts`.

## Why this exists

The Coworld league mirror shows real playing agents by their live `playerName`. Turning that into a public "Builder X's Agent Y" identity is an attribution problem: get it wrong and the site publicly credits (or blames) the wrong person for someone else's agent. Every design choice below — the single matching key, the three-status model, the fields that are `null` until a real verification step exists — exists to keep that attribution honest rather than convenient.

## Registry file layout

Three tracked, version-controlled JSON files, no database:

| File | Contents | Schema |
| --- | --- | --- |
| `resources/identity/builders.json` | `{ schemaVersion: 1, builders: BuilderProfile[] }` | `BuilderRegistryFileSchema` |
| `resources/identity/agents.json` | `{ schemaVersion: 1, agents: AgentProfile[] }` | `AgentRegistryFileSchema` |
| `resources/identity/versions.json` | `{ schemaVersion: 1, versions: AgentVersion[] }` | `AgentVersionRegistryFileSchema` |

They live under `resources/` beside the repo's other tracked reference data (`countries.json`, `flags/`) — small, curated, per-entity JSON the server reads at runtime and an operator hand-edits occasionally (`IdentityRegistry.ts:12-27`). As of this writing `builders.json` has zero entries and `agents.json` has 17 (16 `unclaimed`, 1 `house`) — no agent on the live registry has a `verified` claim yet.

Every object schema in `IdentitySchemas.ts` is `.strict()`: an unrecognized key (a stray secret, a private field, a typo) fails validation instead of round-tripping silently (`IdentitySchemas.ts:3-18`). `loadBuilderRegistry`/`loadAgentRegistry`/`loadAgentVersionRegistry` (`IdentityRegistry.ts:86-116`) parse each file through its Zod schema and throw `IdentityRegistryError` on a read failure, malformed JSON, or a schema violation. `loadIdentityRegistrySnapshot` (`IdentityRegistry.ts:124-134`) loads all three together into an `IdentityRegistrySnapshot { builders, agents, versions }` — the shape every consumer (CLIs, the mirror writer, the public read model) actually wants.

### Fixture override and its production guard

`PROXYWAR_IDENTITY_REGISTRY_DIR` (the `IDENTITY_REGISTRY_DIR_ENV` constant) redirects `resolveIdentityRegistryDir(environment, cwd)` to a different directory (`IdentityRegistry.ts:29-42`). It exists for exactly one caller: the Stage 8 fixture command (`proxywar-public-product-fixtures.ts`), which points a fixture-booted server at synthetic Builders/Agents/Versions without ever touching the tracked registry files. Unset, it falls back to `resources/identity/` under the given `cwd`.

The production guard is two facts working together, both pinned by `tests/server/identity/IdentityRegistryFixtureGuard.test.ts`:

1. `resolveIdentityRegistryDir` only reads the override when the env var is explicitly set to a non-empty string — never a default.
2. No file under `deploy/` (every real launch script, env template, or launchd plist this repo ships) ever sets `PROXYWAR_IDENTITY_REGISTRY_DIR`.

Together, a real deployment has no way to reach fixture identity data short of an operator manually exporting the override — which the same test suite would also catch if a future deploy file ever added it.

## Schemas (`src/server/identity/IdentitySchemas.ts`)

### `IdentityStatusSchema`

`z.enum(["verified", "house", "unclaimed"])` (`IdentitySchemas.ts:48-49`). See [Identity statuses](#identity-statuses-and-transitions) below.

### `BuilderProfileSchema` (`IdentitySchemas.ts:51-70`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `bld_<slug>` |
| `slug` | `string` | `SlugSchema` — lowercase, hyphen-separated |
| `displayName` | `string \| null` | 1–80 chars |
| `shortBio` | `string \| null` | ≤280 chars |
| `avatarUrl` | `string \| null` | must be a URL |
| `verifiedGithub` | `string \| null` | GitHub login, populated **only** once a real sign-in verification mechanism exists — it doesn't yet; never inferred |
| `links` | `string[]` | ≤10 URLs |
| `teamMembers` | `string[]` | ≤20 entries, 1–80 chars each |
| `softmaxPlayerIdentities` | `string[]` | ≤50; Softmax player IDs the builder has **demonstrated control of** — not self-assertion, never populated from a name match |
| `status` | `IdentityStatusSchema` | |

### `PolicyMatchRuleSchema` (`IdentitySchemas.ts:73-89`)

| Field | Type | Notes |
| --- | --- | --- |
| `playerName` | `string` | The primary, authoritative — and only — matching key |
| `policyFamily` | `string` | Policy-label prefix observed at seed time; display/validation only, never re-derives matching |

### `EmblemRefSchema` (`IdentitySchemas.ts:91-101`)

| Field | Type | Notes |
| --- | --- | --- |
| `style` | `"geometric-svg-v1"` (literal) | Only one generator exists today |
| `seed` | `string` | Always the Agent's own stable `id` — same id always produces the exact same SVG bytes (deterministic, pinned by a schema test) |
| `assetPath` | `string` | Repo-root-relative, e.g. `resources/identity/emblems/agt_<id>.svg` |

### `AgentProfileSchema` (`IdentitySchemas.ts:103-123`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `agt_<slug>` |
| `slug` | `string` | `SlugSchema` |
| `displayName` | `string` | 1–80 chars; falls back to the Coworld player name for an unclaimed Agent — never a fabricated brand name |
| `shortCode` | `string` | `ShortCodeSchema` — 2–4 uppercase alphanumeric chars |
| `builderId` | `string \| null` | `bld_<slug>`, nullable |
| `tagline` | `string \| null` | ≤120 chars |
| `description` | `string \| null` | ≤1000 chars |
| `emblem` | `EmblemRefSchema` | |
| `primaryColor` / `secondaryColor` | `string` | `HexColorSchema`, lowercase `#rrggbb` |
| `debutDate` | `string \| null` | ISO `YYYY-MM-DD`; `null` rather than a guessed date |
| `policyMatchRule` | `PolicyMatchRuleSchema` | |
| `status` | `IdentityStatusSchema` | |
| `publicStrategyDescription` | `string \| null` | ≤2000 chars |

### `AgentVersionSchema` (`IdentitySchemas.ts:138-172`)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `agtv_<agent-slug>_v<version>` |
| `agentId` | `string` | `agt_<slug>` |
| `publicVersionLabel` | `string` | e.g. `"v24"` — derived from the policy label's version suffix, never renumbered |
| `softmaxPolicyLabel` | `string` | Exact Softmax policy label, e.g. `"daveey-proxywar:v24"` |
| `immutableDigest` | `string \| null` | Content-addressed artifact digest; always `null` today — Softmax doesn't expose one yet |
| `releaseDate` | `string \| null` | ISO date |
| `releaseNotes` | `string \| null` | ≤2000 chars |
| `declaredBaseModel` | `string \| null` | Only ever set from the builder's **own disclosure** — never inferred from the policy name |
| `scaffoldDescription` | `string \| null` | ≤1000 chars |
| `sourceRepositoryRef` | `string \| null` | |
| `disclosureStatus` | `"undisclosed" \| "disclosed"` | |
| `qualificationStatus` | `"active" \| "retired"` | |
| `observedVia` | `("champion" \| "rating")[]` | 1–2 entries; see below |
| `observedAt` | ISO-8601 UTC timestamp | Registry provenance — bumped on every re-confirmation |
| `firstObservedAt` | ISO-8601 UTC timestamp `\| null` | The mirror's own first-record date for this exact `softmaxPolicyLabel`; set once on creation, never overwritten afterward; distinct from `releaseDate` (a builder disclosure that may predate, postdate, or never arrive); `null` only for a pre-existing record that predates this field |

`ObservedViaSchema` (`IdentitySchemas.ts:136`) preserves the mirror's champion-vs-rating distinction at the version level: a version seen only as the live champion records `["champion"]`; one seen in both feeds records `["champion", "rating"]`; it never collapses the two into one undifferentiated flag.

## Matching algorithm (`src/server/identity/IdentityMatching.ts`)

The module's entire reason to exist, per its own doc comment (`IdentityMatching.ts:3-11`): **`playerName` is the only key ever used to find an Agent** — never a GitHub login, display name, email, or policy label. Those are all user-settable namespaces with no mutual constraint to agree with each other; matching on any of them would be an account-takeover primitive, because a wrong auto-claim publicly attributes someone else's agent to the wrong builder. This module never creates or edits a `BuilderProfile` — it only resolves which already-registered `AgentProfile` a live row belongs to.

- **`findAgentForPlayerName(playerName, agents)`** (`IdentityMatching.ts:36-44`) — exact-match only against `agent.policyMatchRule.playerName`. Coworld's `playerName` is the league's stable per-participant key. No fuzzy or case-insensitive matching, deliberately: `"Daveey"` does not match a registered `"daveey"` — fuzzy matching risks silently merging two distinct participants.
- **`parsePolicyLabel(label)`** (`IdentityMatching.ts:22-33`) — splits a policy label on the **last** colon into `{ family, version }`. Returns `null` for a label with no colon.
- **`resolveObservedVersion(agent, versions, row)`** (`IdentityMatching.ts:67-100`) — resolves what an Agent's live standings row is actually running right now. Prefers the live champion label when present (matches `CoworldLeagueSiteWriter`'s own `policyProvenance` precedent); falls back to the rating label only when the champion label is `null` (a player whose rating feed has data but whose champion feed hasn't reported yet — the seed notes' 8-participant case). Returns `null` only when neither label is present. Otherwise returns an `ObservedVersion`:
  - `policyLabel` — the raw label actually live.
  - `source` — `"champion"` or `"rating"`.
  - `publicVersionLabel` — the parsed version suffix, or `null` for a malformed label.
  - `familyMismatch` — `true` when the live label's parsed family no longer matches the Agent's registered `policyMatchRule.policyFamily`. This is an operator-review signal, **never** a trigger to silently re-map the agent elsewhere — the function still resolves the row to the same agent (playerName already matched). A version bump under the *same* family (`daveey-proxywar:v24` → `:v25`) is expected and normal: `familyMismatch` stays `false`.
  - `registered` — the matching `AgentVersion` record if one exists for the exact live label, else `null`. `null` here is expected and not an error — it's simply a version bump the registry hasn't caught up to yet (`identity:list-unmapped`/`sync-version-registry.ts` territory), and the mirror still renders it correctly from the live label alone.
- **`computeUnmappedPlayerNames(livePlayerNames, agents)`** (`IdentityMatching.ts:109-119`) — live `playerName`s with no registered `AgentProfile`, exactly what `identity:list-unmapped` reports. Non-empty means a real participant is about to render with only a provisional, name-only identity.
- **`resolveAgentIdentityView(row, agents, builders, versions)`** (`IdentityMatching.ts:129-149`) — the one function mirror rendering actually calls: agent lookup by `playerName`, its registered Builder (looked up by `agent.builderId`, if non-null), and its observed version, resolved together as an `AgentIdentityView { agent, builder, version }`. Never partial: `builder`/`version` stay `null` alongside a `null` `agent`. `agent.builderId` is the *only* path to a non-null `builder` — never a name/email/GitHub match. (`agent.builderId` is only ever non-null on a `verified` agent — enforced at the validation layer below, not by this resolver itself.)

## Identity statuses and transitions

| Status | Meaning | What sets it |
| --- | --- | --- |
| `verified` | Builder-claimed and verified | Requires `AgentProfile.builderId` to be non-null and point at a real `BuilderProfile` — enforced as a schema-integrity invariant (see below). Reached only through an operator merging a claim into the registry files by hand; there is no automated path to this status today. |
| `house` | Operator/Softmax baseline agent | Assigned directly in the registry file for house-run agents (one such agent exists in the current `agents.json`). Not a claim state — `CoworldLeagueSiteWriter` renders these with a `HOUSE` badge instead of a builder note and skips the unclaimed note entirely (`CoworldLeagueSiteWriter.ts:1101`). |
| `unclaimed` | Self-registered via `/build`, or simply not yet claimed | The default for every matched agent with no builder. 16 of the 17 agents in the live registry are `unclaimed`. |

There is no code path that flips `status` automatically. Every transition — `unclaimed`/`house` → `verified`, or a brand-new `/build` submission landing in the registry at all — is an operator hand-editing `builders.json`/`agents.json` (see the `/build` flow below). `IdentityValidation.ts` enforces the *result* of that edit is consistent (`verified` implies a resolvable `builderId`) but never performs the edit itself.

## Champion-vs-rating provenance in the public read model

`ProxyWarPublicReadModel.ts`'s whole point, per its module doc, is preserving the mirror's champion-vs-rating distinction rather than collapsing it, alongside atomic publication with last-good snapshots on stale feeds (`ProxyWarPublicReadModel.ts:34-46`).

- **`PublicAgentActiveVersion`** (`ProxyWarPublicReadModel.ts:64-82`) — `publicVersionLabel`, `source` (`"champion" | "rating"`), `familyMismatch`, and `firstObservedAt` (the mirror's own first-record date for this policy label, from the matching `AgentVersion.firstObservedAt` — explicitly **not** the builder's `releaseDate`, which is a separate, still-usually-null field this read model never surfaces).
- **`PublicAgent.registered`** (`ProxyWarPublicReadModel.ts:92-125`) is load-bearing: every consumer must check it before trusting `slug`/`emblemSvg`/`shortCode`/`builderId`. An unregistered live participant still gets a row — `displayName` falls back to the raw Coworld `playerName`, every other identity field is `null` — never fabricated, never silently dropped.
- **`PublicAgent.provenance`** (`ProxyWarPublicReadModel.ts:110-114`, populated at `ProxyWarPublicReadModel.ts:256-259`) — `{ ratingPolicyLabel, activeChampionPolicyLabel }`, the raw exact labels carried through for transparency, explicitly never treated as primary identity.

`tests/server/ProxyWarPublicReadModel.test.ts:200-225` (registered-agent full resolution) and `:226-239` (unregistered-participant fallback) pin both branches of this behavior.

## The no-auto-attribution invariant

No code path is allowed to infer a Builder, a GitHub identity, or a base-model disclosure from anything other than an explicit, verified source. Every enforcement point:

| Where | What it enforces |
| --- | --- |
| `IdentityValidation.ts:112-114` | Schema-integrity check: `status === "verified"` requires `builderId != null`. A verified agent with no builder is a validation failure. Pinned by `tests/server/identity/IdentityValidation.test.ts:156-165` (rejects) and `:167-` (accepts once `builderId` resolves). |
| `IdentitySchemas.ts:58` (`verifiedGithub`) | Populated only once a real sign-in verification mechanism exists — it doesn't yet (unsolved, see Known gaps) — never inferred. |
| `IdentitySchemas.ts:62-66` (`softmaxPlayerIdentities`) | Empty until the builder *demonstrates* control of a Softmax player identity; never self-assertion, never derived from a name match. |
| `IdentitySchemas.ts:150-151` (`declaredBaseModel`) | Only ever set from the builder's own disclosure, never inferred from the policy name. |
| `BuildRegistrationSubmission.ts` (the `/build` self-service flow) | See below — produces a draft, never an instant publish. |
| `CoworldLeagueSiteWriter.ts:1099-1112` (`builderNoteMarkup`) | An unclaimed-but-matched agent shows a translated `"builder_unclaimed"` note; never a fabricated builder name. House agents skip this note entirely (they carry a `HOUSE` badge instead). |
| `CoworldLeagueSiteWriter.ts:1114-1130` (`standingsRowProfileUrl`) | Links to `/agent/<slug>` only when the row actually resolved to a registered Agent; otherwise falls back to `/player/<name>`. Never links to a profile page that doesn't exist. |

### The `/build` self-service draft → operator-merge flow

`/build` (`ai-agent-demo-server.ts:1476-1478`) is a UI route; its registration step posts to `POST /api/build/registration-submission` (`ai-agent-demo-server.ts:1912-1930`), which validates the body against `BuildRegistrationSubmissionInputSchema` and calls `buildRegistrationDraft`.

`BuildRegistrationSubmission.ts`'s own module doc states the reasoning directly: instant self-service publication is **not safe**, because ownership can never be derived from a self-reported GitHub login, display name, or policy label. So `buildRegistrationDraft` (`BuildRegistrationSubmission.ts:97-159`) never writes to `resources/identity/*.json`. It produces:

- `proposedAgent` — an `AgentProfile`-shaped object **minus** `id`, `builderId`, `status`, `debutDate`, and `policyMatchRule` — an operator assigns those at merge time, once the submitter's real Coworld player name is known.
- `proposedBuilder` — a `BuilderProfile`-shaped object **minus** `id`, `status`, and `softmaxPlayerIdentities`, for the same reason. `verifiedGithub` is deliberately absent from this shape entirely: only an operator, after confirming the submitter's actual platform-account-linked GitHub login, ever sets it.
- `claimedGithub` — the submitter's **self-reported** GitHub handle, deliberately named apart from the registry's `verifiedGithub`. An operator must cross-check `claimedGithub` against the real OAuth-produced login before ever copying it into a merged registry file.
- `profileFileJson` / `emblemPreviewSvg` — a "copy this" JSON panel and emblem preview, plus (`buildRegistrationIssueUrl`, `BuildRegistrationSubmission.ts:162-`) a prefilled GitHub "New Issue" URL using GitHub's documented query-param prefill. Never auto-submitted — the submitter reviews and clicks "Submit new issue" themselves in their own browser session.

The submission is a validated draft end to end. The only way an entry in `builders.json`/`agents.json` changes status, gains a `builderId`, or gains a `verifiedGithub`/`softmaxPlayerIdentities` value is an operator hand-editing the tracked JSON files after manually cross-checking the claim.

## Known gaps

- **No real GitHub-login-to-Softmax-control verification mechanism exists yet.** This is spec Stage 1 item 2, and it is unsolved on this branch. `BuilderProfile.verifiedGithub` and `BuilderProfile.softmaxPlayerIdentities` stay `null`/empty by construction until such a mechanism is built — there is no automated way today to prove that the person submitting a `/build` claim actually controls the Softmax player identity (and therefore the live Coworld `playerName`) they're claiming. Every claim submission currently requires a human operator to manually cross-check the submitter's `claimedGithub` against their real platform-account GitHub login, and manually confirm Softmax-player control out of band, before hand-editing the registry files to grant `verified` status.

## Known ambiguous roster links (2026-08-01)

A P0 production review found two live `playerName`s (`identity:list-unmapped`
would have caught both — see "Self-surfacing unmapped counts" below for why
it didn't get run) with no registered `AgentProfile`. Both are now
registered (`agt_james-botts`, `agt_jordan`), but one carries a genuine
attribution ambiguity worth recording rather than silently resolving:

- **`agt_james-botts` ("James Botts") vs `agt_james-boggs` ("James
  Boggs")** — the live standings row for `James Botts` carries
  `policyFamily: "jamesboggs-warlord"`, IDENTICAL to `agt_james-boggs`'s
  registered `policyMatchRule.policyFamily`, while `agt_james-boggs`
  itself has not appeared in any live standings row for at least the
  mirror's current retained-episode window (7 episodes as of this
  writing — too short to independently confirm continuity via match
  history). This is suggestive of a Softmax account display-name change
  (Boggs -> Botts) carrying the same underlying policy lineage forward,
  but it is NOT proof: `policyFamily` is deliberately "display/validation
  only, never re-derives matching" (`IdentityMatching.ts`'s own doc), and
  the no-auto-attribution invariant this whole document describes exists
  precisely because a self-chosen string match is not the same thing as
  verified control. Per that invariant, this was **deliberately NOT
  merged**: `agt_james-boggs` was left untouched (same `id`/`slug`/
  `displayName`/emblem/history), and `agt_james-botts` was registered as
  its own separate, honest entry (`policyMatchRule.playerName: "James
  Botts"`, its own generated emblem). Both remain independently
  `unclaimed`. An operator revisiting this should check: (a) whether
  `James Boggs` ever reappears live under that exact name again (would
  argue against a rename), and (b) whether a future verified claim on
  either agent self-reports the same builder — the claim workflow
  (`PlatformBuilderClaimStore.ts`) is the sanctioned place that
  ambiguity actually gets resolved, via an operator-reviewed claim, not
  a registry-file guess.
- **`agt_jordan` ("Jordan")** — no existing registry entry shares a
  `policyFamily` with `jordan-proxywar-auto`; this is a genuinely new
  entrant with no prior link to evaluate. Registered as a plain new
  entry, no note needed.

## Self-surfacing unmapped counts

`identity:list-unmapped` (`IdentityMatching.ts`'s `computeUnmappedPlayerNames`)
has always correctly detected an unmapped live `playerName` — the P0 above
confirmed this by re-running it against the exact live snapshot that
produced the incident (`18 live participant(s), 17 registered agent(s)`,
`UNMAPPED James Botts`, `UNMAPPED Jordan`). The gap was operational, not a
matching-logic bug: nothing in the mirror sync loop ever ran this check on
its own, so an unmapped participant could accumulate live for days with
nothing surfacing it short of a manual CLI run or a human visually noticing
a blank card. `CoworldLeagueMirrorCore.ts`'s sync cycle now logs the
unmapped count (and every unmapped `playerName`) at `WARN` on every cycle
where it is non-zero — see that module's `logUnmappedParticipants` call —
so this class of drift is visible in ordinary server logs without anyone
remembering to run a CLI.
