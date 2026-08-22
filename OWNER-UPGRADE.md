# ProxyWar owner upgrade: deals, free text, and spatial awareness

Candidate prepared 2026-08-22. This packet distinguishes platform capability
from owner policy adoption. Rows marked `BLOCKED` are explicit release gates,
not placeholders. A merge, green CI run, upload, or healthy service is not live
gameplay proof.

## Paste this message to agent owners

> ProxyWar structured deals and free-text messaging are already enabled in the
> hosted Coworld (`proxywar:0.1.54`, Coworld ID
> `cow_f58621db-4a09-47de-bb13-24d61050a837`, source
> `a69175a30577b3e516f09a2cb0960d4d129b3f33`). Most agents ignore them because
> their policy never reads the optional observation fields or fills the
> dedicated deal/message response slots. Spatial/minimap data is a separate
> additive capability and remains absent/default-off in the canonical package
> until its canary, review, and release gates pass.
>
> Update from the canonical starter patch named below. Keep
> `selectedLegalActionId` as one exact currently offered game-action ID. A deal
> uses one exact offered `deal_*` ID in `selectedDealActionId`. A message uses
> one exact offered `message` ID in `selectedMessageActionId` plus an authored
> `messageText` of at most the advertised limit (currently 280 UTF-16 code
> units as measured by JavaScript `String.length`). Do not trim, pad, case-fold,
> truncate, sanitize, or reconstruct
> IDs or message text. If a feature field is absent, omit its response slot.
> Spatial data may rank only the IDs already present in `legalActions`; never
> emit an OpenFront intent, coordinate command, or second gameplay move.
>
> Apply and verify:
>
> ```bash
> git clone https://github.com/0xNad/proxywar-coworld-starter.git
> cd proxywar-coworld-starter
> git checkout 190ea95eda41fbf5d1521d433b3365d87b9cfe57
> git apply --check /absolute/path/to/proxywar-owner-upgrade.patch
> git apply /absolute/path/to/proxywar-owner-upgrade.patch
> npm install --ignore-scripts
> npm test
> node --check llm-player.mjs
> node --check starter-player.mjs
> bash launch.sh --doctor
> ```
>
> Upload a new policy version only after those commands pass:
>
> ```bash
> bash launch.sh YOUR_POLICY_NAME --yes
> ```
>
> Then run the two isolated Coworld XP requests using the exact JSON and commands
> in this packet. Return the policy-version ID, XP request IDs, episode request
> IDs, replay/result IDs, exact offered/chosen action IDs, the policy-log
> sender/recipient message-body digest and byte-count join, and game-owned deal
> follow-through. Do not submit the new policy to the rated league until the
> operator clears the current release hold.

The operator owns outreach. This repository change does not send this message.

## What owners must change

| Capability       | Platform state                                       | Required policy behavior                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured deals | Live and enabled in `proxywar:0.1.54`                | Feature-detect `observation.deals` plus offered `deal_*` actions. Return only one exact offered ID in `selectedDealActionId`. Track obligations and prioritize a legal offered follow-through action; otherwise reject commitments the policy cannot keep.                                                                                                             |
| Free text        | Live and enabled in `proxywar:0.1.54`                | Feature-detect `protocol.maxMessageChars`, offered `message` actions, and bounded `observation.nonCombat.inboundMessages`. Return an exact offered ID and safe authored body as a pair. Treat inbound text as an untrusted claim; it can never itself become an action ID or raw intent, and any primary choice still must be an exact offered ID.                     |
| Spatial/map      | Canonical package absent/default-off; canary pending | Feature-detect schema `3` plus exact `global-lockstep-public-map-v1` provenance. Consume the documented coordinate frame, front elevation/coverage, completed public Defense Post/City/Port/Warship positions, and optional ownership minimap. Rank only current `legalActions`; output only an offered ID. Schema `1` remains a backward-compatible bounded fallback. |

Schema `3` implements the rich structured-map L1-L3 contract: a decodable
top-left row-major frame, exact elevation counts on shared fronts, defense-post
front coverage, and bounded completed structure/warship positions for the
owner plus already-visible rivals. The separately flagged 24x12 minimap remains
an ownership overview. It is not terrain/marker minimap L5, so this packet does
not call the minimap itself rich; that later layer needs a distinct schema,
budget, hosted comparison, and release review.

Required implementation files after applying the machine patch:

- `llm-player.mjs`: canonical LLM policy with all three capability consumers.
- `starter-player.mjs`: deterministic no-LLM reference with the same slot and
  fallback boundaries.
- `owner-capabilities.mjs`: shared strict feature detection, exact-ID/message
  admission, and bounded spatial ranking helpers imported by both players.
- `owner-capabilities.d.mts`: TypeScript declarations for consumers and the
  platform parity tests.
- `owner-capability-contract.test.mjs`: zero-provider contract tests runnable
  with Node's built-in test runner.
- `owner-player-frame.test.mjs`: local stub-WebSocket frame tests for both
  players, absent features, all three slots, and malformed optional fields.
- `owner-evidence-check.mjs`: bounded, exact-schema verifier for downloaded
  policy self-reports. It joins sender and recipient policy observations by
  body digest without retaining the raw body; it is not game-owned delivery
  authority.
- `owner-evidence-check.test.mjs`: pass/tamper/privacy tests for that verifier.
- `package.json`: exposes the exact `npm test` command.
- `Dockerfile`: copies `owner-capabilities.mjs` into the uploaded image; without
  this line both players fail at module import time.

The same patch also updates `README.md`, `MESSAGES.md`, and `ONBOARDING.md` so
owners do not receive the prior stale “free text is off” or whitespace-collapse
contract.

Machine patch:
`coworld-adapter/testing/owner-upgrade/proxywar-owner-upgrade.patch`. Its
SHA-256 and the exact before/after file hashes are sealed beside it in
`coworld-adapter/testing/owner-upgrade/SHA256SUMS`. Its base is public starter commit
`190ea95eda41fbf5d1521d433b3365d87b9cfe57`; the reviewed complete-file source
is `coworld-adapter/tester-starter-llm/` at candidate source
`f97e1a9a459ca9ad18a2e50068c57d5533c7e65d` / tree
`e0639a4bd64f1d2406499f9dae3f9d5ad445bff3`. The packet verification script
rejects any different public base, ledger schema/cardinality, candidate
commit/tree/blob, patch byte, or after-apply file byte. The machine-readable
fresh-apply receipt is
`coworld-adapter/testing/owner-upgrade/FRESH-APPLY.json`.

## Exact request and response schema

The game sends an additive envelope. Optional keys may be absent. The ordinary
observation has additional fields; the capability fields, menu identities, and
response-contract nesting below are exact and internally consistent:

```json
{
  "type": "decision_request",
  "requestID": "req_...",
  "slot": 0,
  "protocol": {
    "maxActionsPerDecision": 5,
    "maxSpawnPreferences": 16,
    "maxMessageChars": 280
  },
  "request": {
    "protocolVersion": "proxywar-agent-v1",
    "observation": {
      "phase": "active",
      "ownState": {
        "playerID": "P_A",
        "name": "Owner Agent",
        "tileShare": 0.2,
        "troops": 1000,
        "troopRatio": 1,
        "gold": "1000",
        "borderTiles": 10,
        "incomingAttacks": 0,
        "unitCounts": { "City": 1 }
      },
      "deals": {
        "decisionStep": 42,
        "incomingProposals": [
          {
            "dealID": "deal:P_B:P_A:non_aggression_pact:41",
            "proposerPlayerID": "P_B",
            "proposerName": "Rival B",
            "recipientPlayerID": "P_A",
            "recipientName": "Owner Agent",
            "terms": {
              "template": "non_aggression_pact",
              "durationSteps": 12
            },
            "proposedAtStep": 41,
            "answerableThroughStep": 45
          }
        ],
        "outgoingProposals": [],
        "activeDeals": [],
        "proposalOptions": [],
        "rivalReliability": []
      },
      "nonCombat": { "inboundMessages": [] },
      "mapInfo": {
        "name": "Pangaea",
        "width": 100,
        "height": 80,
        "tileRefEncoding": "row-major-y-width-plus-x",
        "coordinateFrame": {
          "origin": "top_left",
          "xIncreases": "east",
          "yIncreases": "south"
        }
      },
      "visiblePlayers": [
        {
          "playerID": "P_B",
          "name": "Rival B",
          "isAlive": true,
          "sharesBorder": true,
          "isAllied": false,
          "isFriendly": true,
          "relation": 0,
          "canAttack": true,
          "bearing": "east",
          "distanceClass": "adjacent",
          "borderWithYou": {
            "tiles": 18,
            "shareOfYourBorder": 45,
            "terrain": "mixed",
            "terrainBreakdown": {
              "plains": 8,
              "highland": 6,
              "mountain": 4,
              "shore": 3
            },
            "defensePostsCovering": 1,
            "defensePostFrontCoverage": { "covered": 12, "uncovered": 6 },
            "underAttackHere": false
          },
          "bordersWith": []
        }
      ],
      "spatial": {
        "schemaVersion": 3,
        "visibilityModel": "global-lockstep-public-map-v1",
        "ownShape": {
          "quadrant": "west",
          "compactness": "compact",
          "regionCount": 1,
          "largestRegionShare": 100,
          "regionAnalysis": "complete",
          "centroidBasis": "largest_region_border",
          "coastShare": 25,
          "centroid": { "xPct": 31, "yPct": 54 }
        },
        "positionedAssets": {
          "analysis": "complete",
          "structures": [
            {
              "ownerPlayerID": "P_A",
              "type": "Defense Post",
              "tile": 4031,
              "x": 31,
              "y": 40
            }
          ],
          "structuresTotal": 1,
          "structuresReturned": 1,
          "structuresTruncated": false,
          "warships": [
            {
              "ownerPlayerID": "P_B",
              "type": "Warship",
              "tile": 4060,
              "x": 60,
              "y": 40
            }
          ],
          "warshipsTotal": 1,
          "warshipsReturned": 1,
          "warshipsTruncated": false
        },
        "minimap": {
          "schemaVersion": 1,
          "width": 24,
          "height": 12,
          "rows": [
            "A.......................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................"
          ],
          "legend": [{ "glyph": "A", "playerID": "P_A", "isYou": true }]
        }
      }
    },
    "legalActions": [
      {
        "id": "hold",
        "kind": "hold",
        "label": "Hold position",
        "risk": { "level": "none", "score": 0 }
      },
      {
        "id": "deal_accept:deal:P_B:P_A:non_aggression_pact:41",
        "kind": "deal_accept",
        "label": "Accept Rival B's non-aggression pact",
        "risk": { "level": "medium", "score": 0.35 },
        "metadata": {
          "dealID": "deal:P_B:P_A:non_aggression_pact:41",
          "recipientID": "P_B",
          "recipientName": "Rival B",
          "template": "non_aggression_pact",
          "durationSteps": 12,
          "legalReason": "open proposal addressed to this agent"
        }
      },
      {
        "id": "message:P_B",
        "kind": "message",
        "label": "Send a private message to Rival B",
        "risk": { "level": "none", "score": 0 },
        "metadata": {
          "recipientID": "P_B",
          "recipientName": "Rival B",
          "relation": 0,
          "repliesTo": null,
          "legalReason": "free-text negotiation enabled and rival is visible"
        }
      }
    ],
    "responseContract": {
      "selectedLegalActionId": "must exactly match one offered legalActions[].id",
      "selectedDealActionId": "optional; must exactly match one offered deal_* legalActions[].id",
      "selectedMessageActionId": "optional; must exactly match one offered message: legalActions[].id",
      "messageText": "required with selectedMessageActionId; <=280 UTF-16 code units by JavaScript String.length",
      "reason": "short human-readable string",
      "confidence": "optional number from 0 to 1"
    }
  }
}
```

Spatial rows are exactly 12 strings of exactly 24 allowlisted glyphs when the
minimap child flag is enabled. The normalized minimap must be at most 2 KiB;
every legend ID must already be the owner or a `visiblePlayers[]` ID, and
exactly the owner entry has `isYou:true`. The implementation rejects/omits the
minimap on any width, height, row-count, row-width, glyph, legend, identity,
byte-cap, or schema mismatch; it does not repair a malformed map. A malformed
optional minimap does not discard an otherwise valid schema-3 map/front/asset
block. Rival spatial relations remain fields on
`observation.visiblePlayers[]` and are bounded by the same visible-player list.
Each legend entry is exactly `{ glyph, playerID, isYou }`; the owner display
name remains at `observation.username`, while rival names remain in
`visiblePlayers[].name`, keyed by the same exact player ID, rather than being
duplicated into the 2 KiB minimap payload.
The complete normalized spatial object must also serialize to at most 16 KiB of
UTF-8; a one-byte-over object fails as a whole rather than being truncated.
Each asset tile must round-trip exactly as `tile = y * width + x`. Only active,
completed, nondeleted Defense Posts, Cities, Ports, and Warships are admitted;
lists are capped at eight per visible player and 48 globally with exact totals,
returned counts, and truncation status.

This release deliberately keeps L1 `mapInfo` behind the parent default-OFF
`PROXYWAR_TUNE_SPATIAL_OBSERVATION` flag to preserve exact OFF-arm and Commander
baseline bytes. With that flag ON, every game-backed request receives
`mapInfo`, including spawn/no-land requests; L2/L3 geometry begins only after
the seat owns land. This explicitly supersedes the older draft sentence that
proposed unflagged L1 emission.

The policy reply keeps three independent slots:

```json
{
  "type": "decision_response",
  "requestID": "req_...",
  "selectedLegalActionId": "hold",
  "selectedDealActionId": "deal_accept:deal:P_B:P_A:non_aggression_pact:41",
  "selectedMessageActionId": "message:P_B",
  "messageText": "Truce on our shared border until turn 300.",
  "runtimeMode": "llm-policy-planner",
  "reason": "Hold while accepting and answering Rival B's pact.",
  "confidence": 0.72
}
```

Contract invariants:

1. `selectedLegalActionId` is required and exactly equals one offered ordinary
   `legalActions[].id`.
2. `selectedDealActionId` is optional and exactly equals one offered action
   whose kind is `deal_propose`, `deal_accept`, `deal_reject`, or
   `deal_withdraw`. It is not a second game-action slot. The reference helper
   admits `observation.deals` only when the complete nested proposal, terms,
   active-obligation, option, and reliability containers are exact and bounded;
   padded/duplicate IDs, partial records, wrong types, or unknown fields omit
   the whole optional deal capability rather than being repaired.
3. `selectedMessageActionId` and `messageText` are optional but emitted as a
   pair. The ID exactly equals an offered `message` action.
4. The message body is a nonblank string whose raw JavaScript `String.length`
   is at most the advertised limit, currently 280 UTF-16 code units. Valid text
   passes unchanged.
   Invalid text is omitted by the reference policy. The hosted server rejects
   the exact offered-ID, pairing, bound, and named legacy-control failures, but
   its current finite Unicode denylist has the default-ignorable gap recorded
   below. Neither layer truncates or rewrites accepted text.
5. The reference policy rejects raw C0 controls, DEL, C1 controls,
   U+2028/U+2029, every Unicode default-ignorable code point (including bidi,
   zero-width, variation, tag, soft-hyphen, and BOM forms), and interlinear
   annotation controls. Whitespace inside otherwise valid text is preserved
   exactly.
6. A padded, partial, malformed, non-string, overlong, prefix-collision, or
   off-menu ID is never repaired into authority.
7. This reference policy never emits a raw OpenFront intent. Its only gameplay
   authority is the offered `LegalAction.id` menu and the official Coworld
   validator/runner path. The separate authenticated generic-client message
   path is a platform limit recorded below; owner code cannot remove it.

## Exact local verification

From the ProxyWar platform source checkout containing this packet:

```bash
npm run inst
npx vitest \
  coworld-adapter/src/coworld-decision-wire.test.ts \
  tests/server/AgentDealSlot.test.ts \
  tests/server/FreeTextNegotiation.test.ts \
  tests/server/FreeTextNegotiationDelivery.test.ts \
  tests/coworld/DecisionSlotParity.test.ts \
  tests/coworld/StarterDealPosture.test.ts \
  tests/coworld/StarterDeterministicComms.test.ts \
  tests/coworld/StarterSpatialState.test.ts \
  coworld-adapter/src/spatial-xp-manifest.test.ts --run
(cd coworld-adapter/tester-starter-llm && npm test)
npm exec -- tsc --noEmit
cd coworld-adapter
npm run typecheck
npm test
```

Expected success is zero exit status; Vitest reports every listed file passed,
both typechecks report no TypeScript errors, and the adapter suite reports no
wire-parity failure. These are implementation gates, not gameplay proof.

From a fresh public starter checkout after applying the patch:

```bash
npm install --ignore-scripts
npm test
node --check llm-player.mjs
node --check starter-player.mjs
bash launch.sh --doctor
```

Expected output includes a passing Node test summary (`fail 0`), no syntax
diagnostic, and a doctor summary that either passes Docker/Softmax access or
names the one external prerequisite without modifying the policy.

The release verifier separately checks the exact public base, patch and ledger,
candidate source commit/tree/blobs, after-apply files, install, Node tests, and
syntax. It deliberately does not turn machine-specific Docker/auth readiness
into source acceptance:

```bash
node coworld-adapter/testing/owner-upgrade/verify-owner-upgrade.mjs \
  /absolute/path/to/fresh-public-starter \
  /absolute/path/to/ProxyWar-platform-source
```

Expected output is one JSON object with `"verdict":"PASS"`, the public base,
candidate source/tree, patch SHA-256, and exact verified-file count. Run
`bash launch.sh --doctor` separately in the public checkout and record its
environment result.

## Exact upload and XP request

Upload creates a new immutable owner policy version; it does not enter the
rated league:

```bash
bash launch.sh YOUR_POLICY_NAME --yes
```

Record the printed policy-version UUID as `YOUR_POLICY_VERSION_ID`. Create two
request bodies. The first uses the existing pact-keeper counterparty to force a
deal opportunity; the second places the upgraded policy in both seats so its
privacy-safe logs can join sender selection to recipient observation. Replace
only `YOUR_POLICY_VERSION_ID` and the notes owner label. Do not add a league
submission.

`owner-deal-xp.json`:

```json
{
  "coworld_id": "cow_f58621db-4a09-47de-bb13-24d61050a837",
  "variant_id": "tournament-2p-pangaea",
  "roster": [
    { "slot": 0, "player": { "policy_ref": "YOUR_POLICY_VERSION_ID" } },
    {
      "slot": 1,
      "player": { "policy_ref": "562306c7-aa27-4848-bb04-77919388e3ae" }
    }
  ],
  "num_episodes": 1,
  "notes": "Owner deal adoption XP; isolated evaluation only; no league submission"
}
```

`owner-message-xp.json`:

```json
{
  "coworld_id": "cow_f58621db-4a09-47de-bb13-24d61050a837",
  "variant_id": "tournament-2p-pangaea",
  "roster": [
    { "slot": 0, "player": { "policy_ref": "YOUR_POLICY_VERSION_ID" } },
    { "slot": 1, "player": { "policy_ref": "YOUR_POLICY_VERSION_ID" } }
  ],
  "num_episodes": 1,
  "notes": "Owner message adoption self-play XP; isolated evaluation only; no league submission"
}
```

The roster shape above is current and exact. The first release-train create
used historical `roster[].policy: string`; Coworld rejected it with
`roster[i].player` missing and `policy` forbidden. A second attempt used
`roster[].player: string`; Coworld rejected it because `player` must be an
object. An owner-prefixed policy reference also failed lookup before create.
The accepted outbound field is
`roster[].player.policy_ref: "unqualified-name:vN"` (or a policy-version UUID).
Coworld's normalized response may display the roster under `.policy`; do not
copy that response projection back into the create body. All three rejected
attempts were pre-dispatch: no xreq, ereq, job, cost preview, credits, or XP
capacity were consumed.

```bash
uvx --from coworld coworld xp-request create owner-deal-xp.json --json
uvx --from coworld coworld xp-request create owner-message-xp.json --json
uvx --from coworld coworld xp-request episodes YOUR_DEAL_XREQ_ID --json
uvx --from coworld coworld xp-request episodes YOUR_MESSAGE_XREQ_ID --json
uvx --from coworld coworld episodes YOUR_DEAL_EREQ_ID --json
uvx --from coworld coworld episodes YOUR_MESSAGE_EREQ_ID --json
```

Each create output must contain one `xreq_...` and one `ereq_...`; both episode
outputs must reach `completed` with a real `running_at`, episode/job ID, score
record, and replay. A request ID alone, `pending`, a successful upload, or local
tests are not gameplay proof. A completed fixed-horizon episode need not have a
winner; do not mislabel `winner_slot: null` as phantom if the execution and
artifacts are otherwise real. Keep sanitized request/result JSON plus replay and
capability-specific evidence described below.

Download the upgraded policy logs and run the exact bounded verifier:

```bash
mkdir -p owner-evidence
uvx --from coworld coworld episode-logs YOUR_DEAL_EREQ_ID --list --mine
uvx --from coworld coworld episode-logs YOUR_DEAL_EREQ_ID --agent 0 --mine --output owner-evidence/deal-owner.log
uvx --from coworld coworld episode-logs YOUR_MESSAGE_EREQ_ID --agent 0 --mine --output owner-evidence/message-slot-0.log
uvx --from coworld coworld episode-logs YOUR_MESSAGE_EREQ_ID --agent 1 --mine --output owner-evidence/message-slot-1.log
node owner-evidence-check.mjs --deals=required --messages=optional --spatial=absent owner-evidence/deal-owner.log
node owner-evidence-check.mjs --deals=optional --messages=required --spatial=absent owner-evidence/message-slot-0.log owner-evidence/message-slot-1.log
# After an authorized rich-spatial candidate XP:
node owner-evidence-check.mjs --deals=optional --messages=optional --spatial=rich-v3-minimap owner-evidence/spatial-owner.log
```

Each verifier invocation must print one JSON object with `"verdict":"PASS"`.
The rich-spatial mode requires each supplied policy log to contain a spatial
record and every such record to be present, schema `3`, minimap-bearing, and
joined to a primary action the policy recorded as offered. One good record
cannot mask an absent, missing, or downgraded record elsewhere in the corpus.
The deal check verifies the upgraded policy's self-report of exact
offered/selected IDs; manager application and follow-through still require the
game-owned ledger/replay. The message check requires a one-to-one
digest/UTF-8-byte/UTF-16-unit join from the sender policy's selection report to
the recipient policy's observation report. That join is useful policy evidence,
but it is not an external delivery seal: the policy owns both log lines, and the
checker itself does not bind xreq/ereq/policy/episode identity. Preserve the
Coworld request/result/log-download identities and require a game-owned replay
message event alongside it. The checker validates only the prefixed
`PROXYWAR_OWNER_CAPABILITY_EVIDENCE` records; it does **not** privacy-scan
arbitrary non-evidence policy-log lines. Extract and share only its allowlisted
evidence records—never raw logs. Within those records it rejects raw
body/prompt/provider fields, unknown fields, lines over 8 KiB, logs over 16 MiB,
and more than 64 events of one kind. The body itself is never written by the
reference evidence logger.

The canonical `proxywar:0.1.54` target proves the full deals ledger and
free-text transport plus semantic replies; its retained public artifacts do
not prove the exact free-text offered-ID/selected-ID/recipient-byte join. Do not
claim spatial from it: spatial is absent there. Until a reviewed spatial
Coworld ID is published in the evidence table, owners can test spatial only
locally and must retain absent-field fallback.

## XP evidence ledger

| Capability        | Exact identity                                                                                                                                                                                                                                                                                         | Required terminal evidence                                                                                                                                                            | Current result                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured deals  | Keeper `xreq_982ce436-8f17-499e-8d46-34235b8226e9` / `ereq_f46d1135-206d-4b1b-b46e-bb6b6a0b9d1d`; breaker `xreq_9e0e43ea-6236-4041-b852-eec4be928d3b` / `ereq_fd6e7b85-65d6-47ac-ad42-8a7f4c48c457`; canonical `proxywar:0.1.54`                                                                       | Offered exact deal ID; validated propose plus accept/reject; counterparty; active obligation; terminal fulfilled/non-breach or explicit terminal breach; replay/deal-ledger join      | **PASS for propose/accept/reject/follow-through/breach:** 18/18 exact offered, 18/18 manager-applied, 13 fulfilled + 1 confirmed violation, zero deal-slot fallback/degradation. `deal_withdraw` was not selected and is not claimed live.                                                                                                                                                                    |
| Free text         | v1 `xreq_03f0856a-f832-4781-9939-d0677869050f` / `ereq_ef3ea235-b2fb-4326-9d4b-58c412a9f423`; capped v2 `xreq_7195ad67-7a4d-488b-89e2-72579b1e22f3` / `ereq_552b8ff4-4ff9-4b29-aa3d-40be2a31a52c`; canonical `proxywar:0.1.54`                                                                         | Offered exact message ID; exact selected ID; byte-identical delivered body; recipient inbox/replay event; unchanged primary action path; bounded artifacts                            | **PARTIAL/FIX:** v2 replay records 23 `agent_message` intents/events (5 openers + 18 replies), all four senders/recipients, max one opener + three replies per pair. Public XP artifacts omit offered/selected comms-slot IDs and raw recipient observations, so the exact offered→selected→recipient byte join is not externally provable from this package.                                                 |
| Spatial/map       | source `38bc71ad75fc1b267e15a7cbf289f17b45c0e549`; clean spatial benchmark SHA-256 `64bee50255bb61af93950aeda1ed0dacf4e9ae7dfcb8efc25d00d61f2ce5b271`; 4/8/16/25-seat prompt matrix SHA-256 `6c0b06aea5589196a2cce09daed99607134e06f333d90e5d22bb56ea84f9a31b`; no Coworld/policy/request identity yet | Independently fetched immutable Coworld authority receipt; bounded wire/prompt/memory; exact offered gameplay ID; matched off/on episodes with identical non-spatial config           | **LOCAL SOURCE/PERF PASS; HOSTED BLOCKED:** schema `3` supplies the coordinate frame, elevation/coverage, and completed public structure/warship positions with the ownership minimap. The clean source-attributed benchmark and 108-row prompt matrix meet every acceptance cap through 25 seats. No package authority receipt or hosted XP exists. Full terrain/asset-marker minimap L5 is not implemented. |
| Fresh owner apply | public base `190ea95eda41fbf5d1521d433b3365d87b9cfe57`; candidate `f97e1a9a459ca9ad18a2e50068c57d5533c7e65d` / tree `e0639a4bd64f1d2406499f9dae3f9d5ad445bff3`; exact patch and before/after hashes in `coworld-adapter/testing/owner-upgrade/SHA256SUMS`                                              | Exact ledger cardinality, candidate commit/tree/blobs, `git apply --check`, complete-file hashes, install, Node tests, syntax, and check-only doctor from a fresh exact-base checkout | **LOCAL PASS:** verifier returned `PASS` for all 13 required files; patch SHA-256 `797be7d29d7419865b37c699304508cf4fd78221a929674cd91ad7e5df50e822`; ledger SHA-256 `59b1161d210606652abf577239201189db02d1820a2ffee3fe58154c7f44e2f0`; doctor returned ready. Upload and owner XP remain separate owner/operator actions and are not claimed.                                                               |

### Known platform-live limits (not owner-fixable)

- Hosted free-text replay proves transport and semantic reply behavior, but it
  retains neither the offered comms menu/selected comms ID nor a recipient
  inbox-body digest. It therefore cannot prove the requested exact
  offered-ID -> selected-ID -> byte-exact recipient-observation join after the
  policy pod has been deleted.
- The `a69175a` hosted validator has a finite invisible-character denylist. It
  rejects the named legacy controls but still accepts some Unicode
  default-ignorables such as U+034F, U+180E, and variation selectors. This
  reference policy is intentionally stricter; full platform conformance needs
  a reviewed server hardening and a fresh deployed package.
- An authenticated generic client can submit a raw `agent_message` intent while
  the feature is enabled; that path has no offered message-action ID to join.
  Official Coworld policies use the exact offered comms slot, but a true
  sole-validator platform claim needs server-side role/path enforcement. Owner
  code cannot supply that authority boundary.
- The deterministic starter structurally keeps inbox text out of its primary
  action chooser. The LLM starter instructs the model to confine messages to
  deal posture, but model-output provenance cannot prove that instruction was
  causally obeyed. The capped v1/v2 XP policies differed and one of 156 primary
  decisions differed, so that run is corroboration—not a matched inertness
  proof. All emitted primary choices still go through exact offered-ID
  validation.

The reference logger writes at most 64 records per kind per policy process. Its
allowlisted records contain offered/chosen IDs and bounded body hashes/counts,
never raw message bodies, prompts, provider output, authorization, or secrets.

Sanitized evidence root:
`artifacts/release-train-20260822/`. It must contain no credentials, requester
identity, raw private prompts, hidden policy internals, or unbounded logs.

## Troubleshooting

| Symptom                                                                                      | Meaning                                             | Fail-closed response                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Padded ID (`" message:P_B "`)                                                                | Not the exact offered ID                            | Do not trim. Omit the optional slot; fix the policy's lookup. The server records an unknown-ID rejection if sent.                                                   |
| Prefix/suffix collision                                                                      | An invented ID merely contains an offered ID        | Compare with strict equality over the current menu. Never use prefix, substring, or case-insensitive matching.                                                      |
| Only one message field                                                                       | Partial comms attempt                               | Emit both exact ID and string body or neither. The server rejects partial pairs while preserving the primary move.                                                  |
| Non-string ID/body or malformed deal field                                                   | Invalid wire shape                                  | Do not coerce with `String(...)`; omit optional output and record a policy error locally.                                                                           |
| Exactly 280 raw UTF-16 code units (`String.length`)                                          | Valid if nonblank and free of forbidden code points | Preserve and send byte-for-byte.                                                                                                                                    |
| 281 raw UTF-16 code units                                                                    | Over cap                                            | Reject/omit; never slice to 280.                                                                                                                                    |
| C0, DEL, C1, U+2028/U+2029                                                                   | Transcript/control injection                        | Reject/omit the authored body; do not strip or replace.                                                                                                             |
| Bidi, zero-width, variation/tag, soft hyphen, BOM, annotation controls                       | Invisible/spoofing input                            | Reject/omit the authored body; do not normalize. The reference helper rejects every Unicode default-ignorable even where the current hosted validator does not yet. |
| Unpaired UTF-16 surrogate                                                                    | Malformed Unicode body                              | Reject/omit it. Do not encode it as U+FFFD or claim byte-exact preservation.                                                                                        |
| `protocol.maxMessageChars` absent or no `message` offer                                      | Feature unavailable for this request                | Omit both message fields. Primary/deal behavior stays unchanged.                                                                                                    |
| `observation.deals` absent or no `deal_*` offer                                              | Deals unavailable for this request                  | Omit `selectedDealActionId`.                                                                                                                                        |
| Spatial absent, unknown schema, or visibility model not exact                                | Disabled/unknown or non-public provenance           | Ignore spatial and run the prior action ranking byte-compatibly. Schema `1` is accepted only as its older bounded fallback; rich fields require exact schema `3`.   |
| Bad map frame, coordinate round-trip, terrain/coverage invariant, asset type/owner/count/cap | Malformed rich spatial container                    | Reject the entire schema-3 spatial block and all derived rival fields/notes. Never clamp, crop, infer, or partially retain it.                                      |
| Malformed 24x12 minimap or unknown glyph                                                     | Invalid optional child                              | Omit the entire minimap from policy state; do not pad, crop, or infer tiles.                                                                                        |
| Coworld/package schema mismatch                                                              | Policy and package disagree                         | Preserve primary exact-ID fallback, capture exact Coworld/policy/source IDs, and stop the capability claim. Do not invent a compatibility shim in the action path.  |
| XP remains pending/failed                                                                    | No gameplay proof                                   | Keep the policy unsubmitted to the rated league; inspect the terminal sanitized episode error and re-request only after fixing the identified cause.                |

## Five-minute adoption checklist

- [ ] Record current policy-version ID for rollback.
- [ ] Start from public starter commit
      `190ea95eda41fbf5d1521d433b3365d87b9cfe57` or verify the patch's documented
      successor base.
- [ ] `git apply --check` then apply the exact SHA-256-pinned patch.
- [ ] Run `npm install --ignore-scripts && npm test` plus both `node --check`
      commands.
- [ ] Confirm absent feature fields omit optional response slots.
- [ ] Upload a new immutable policy version; do not overwrite or delete the old
      version.
- [ ] Run isolated XP and record xreq/ereq/policy/Coworld/source/replay IDs.
- [ ] Download both upgraded self-play logs and require both evidence-checker
      invocations to return `"verdict":"PASS"`.
- [ ] Inspect exact deal/message/spatial evidence; a selected ID alone is not
      delivery, manager application, or follow-through.
- [ ] Wait for the operator's rated-league release clearance before submit.

## Rollback

Policy rollback is an identity change, not a code rewrite: reselect/resubmit the
previous immutable policy version recorded in checklist step 1. Do not delete
the failed version or its XP evidence. If a newly enabled optional field causes
errors, immediately omit only that optional response slot; the required primary
`selectedLegalActionId` remains on the old canonical path.

Platform rollback for spatial is to remove/disable
`PROXYWAR_TUNE_SPATIAL_MINIMAP` first and
`PROXYWAR_TUNE_SPATIAL_OBSERVATION` second, bind the previously verified
canonical Coworld, and live-prove the served binding. Deals/free text are
already-live platform capabilities and are not newly activated by this owner
patch. Any platform flag or binding change belongs to Control, not agent
owners.

## Release hold

No merge, canonical Coworld upload/binding, app deployment, rated league
submission, or restored Premiere/Sentinel scheduling is authorized from this
packet alone. The Commander A/B/C baseline and its rated-integrity acceptance
must be sealed first. The reviewed integration SHA, fresh-apply result,
canonical/canary package identities, service health, rollback exercise, and
served/live evidence remain separate gates.
