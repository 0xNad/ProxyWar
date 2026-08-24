# Commander Coworld functional runner

`agent:commander:coworld` submits matched A/B/C triplets directly to Coworld,
waits for every episode, downloads the subject policy artifacts and replays,
checks that each arm actually used its intended runtime, and writes a bounded
JSON and Markdown report.

```bash
npm run agent:commander:coworld -- \
  --coworld-id=cow_UUID \
  --policy-a=UUID \
  --policy-b=UUID \
  --policy-c=UUID \
  --opponent-policy=UUID \
  --seeds=18,19,20 \
  --subject-seats=1,2,3 \
  --run-id=unique-run-name \
  --output=coworld-adapter/tmp/commander-evidence/unique-run-name
```

For each seed/seat pair, all three arms receive the same map, gameplay limits,
opponents, and derived Coworld game ID. The only policy change is the subject
arm. The request deliberately omits `llm_routing_override`; the hosted policy
environment provides Bedrock access.

The command fails unless every request yields exactly one completed episode,
one valid winner, four participant scores, a downloadable replay, a subject
artifact whose manifest matches the requested arm/run/seed, one successful
provider preflight, and zero provider failures, fallbacks, or degraded
decisions. It also requires hosted-planner calls for A, deterministic Commander
decisions and no gameplay provider calls for B, and successful selector calls
for C. B and C must also execute at least one non-hold action under a
non-`survive` Commander family; a behavior-inert hold-only policy fails.

Outputs:

- `functional-report.json`: request, episode, job, replay, artifact, trace,
  outcome, cost, and arm-level aggregate data.
- `functional-report.md`: a compact human-readable table and claim boundary.
- `artifacts/*.zip` and `replays/*.replay`: downloaded evidence bytes.
- `requests/*.json` and `created.json`: exact submitted inputs and returned XP
  request identities.

Coworld currently creates a new XP request when the same idempotency key is
submitted again. To resume collection or regenerate a report without spending
new requests, use a prior exact manifest explicitly:

```bash
npm run agent:commander:coworld -- \
  same Coworld, policy, seed, seat, and run-id arguments \
  \
  --output=coworld-adapter/tmp/commander-evidence/resumed-report < the > --resume-created=/absolute/path/to/created.json
```

The runner compares every persisted request body, arm, seed, seat, and run key
to the newly constructed plan before it accepts any saved XP request ID.

This command produces functional matched evidence. A small number of triplets
does not establish a statistical performance difference between arms.
