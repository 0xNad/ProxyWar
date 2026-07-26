# Proxy War — writeup (2026-06-12)

Two sections from shared material. Section 1 is recruitment copy for external
developers. Section 2 is a proof-of-work narrative for operator credibility.

Tone rule for this doc: technical and honest, no overclaiming. Where a claim is
about agent strength rather than protocol/infrastructure, it is framed as
**in progress** — the LLM brain has not yet won a hosted game with the model live
(see Section 2 for exactly why), and nothing here should be read as saying it has.

Sourcing: claims are grounded in the repo's durable docs — `docs/project-state/KEYSTONE.md`,
`docs/project-state/2026-06-09-agent-architecture-commander-executor-v2.md`,
`coworld-adapter/ENTER_THE_LEAGUE.md`, and the `docs/project-state/decision-log.md`
rows dated 2026-06-09 through 2026-06-13. No numbers appear here that are not in
those sources.

---

## Section 1 — Enter the Proxy War league (for external developers)

### What Proxy War is

Proxy War is a real-time territorial strategy game (an OpenFront.io fork) turned
into an arena for autonomous agents. You don't move a mouse — you write a policy
that plays. Many independent agents share one map: they expand into neutral land,
attack each other, form alliances, hold or break them, and the last one standing
(or the one holding the most territory) wins.

### Why it's an interesting agent problem

- **You only ever pick one offered `LegalAction.id`.** Each turn the game hands
  your policy a full `observation` plus a list of **legal actions** — attacks,
  expansions, boats, builds, alliance moves, signals — each with an `id`, a kind,
  a label, and a risk hint. Your only job is to reply with exactly one of those
  ids. There are no raw game intents to construct; the game validates every
  selection server-side, so your policy can't break the simulation — only play it
  well or badly. That makes this a clean decision-making problem: all the
  mechanical legality is handled for you, and what's left is pure judgment over a
  changing menu of real options.
- **A 15-second decision clock.** Every `decision_request` must be answered within
  15 seconds, or the game rejects the turn. That's a real architectural
  constraint, not a suggestion: a policy that blocks the clock on a slow model
  call loses turns. The interesting designs answer instantly from a standing plan
  and refresh their expensive reasoning asynchronously, off the response path.
- **Diplomacy, alliances, and betrayal at scale.** This is an FFA, not a duel.
  Rivals form blocs, a 3-versus-1 can assemble against the leader, alliances are
  worth holding until they aren't, and timing a betrayal (position-conditional, by
  the strong agents) is often what decides a game. Modeling who is allied with
  whom, who is about to turn, and when to commit decisively is where the depth is.

### The live league

Proxy War runs a live, always-on league on
[Softmax's Observatory](https://softmax.com/observatory). Rounds start every 30
minutes. Every policy plays full tournament games (50 decisions × 100 turns,
~5,000-turn matches), and every episode produces a watchable replay that opens
straight into the match, plus per-decision logs and scores. Your seat plays
whether you're online or not. Scoring: an outright winner takes 1.0, otherwise you
get your normalized territory share.

Any language that can speak websockets works — your policy is one container per
seat, connecting to a websocket the platform gives it, receiving
`decision_request` messages and answering with one `selectedLegalActionId`.

### How to enter

The full, current zero-to-seated path — the protocol contract, a fork-the-
reference-policy fast path, local episode testing, and the upload/submit commands —
lives in **[`coworld-adapter/ENTER_THE_LEAGUE.md`](../coworld-adapter/ENTER_THE_LEAGUE.md)**.
Start there. In short:

1. Fork the reference LLM policy (or the ~80-line minimal starter) in the adapter.
2. Test one local episode against the bundled players with replay verification
   (needs Docker linux/amd64, Node 24+, and `uv`; the league uses the `coworld`
   CLI, currently pinned at `coworld==0.1.20`).
3. Upload your policy container and submit it to the league. New policies start in
   Qualifiers and graduate to the Competition division automatically.

One house rule worth internalizing before you build: **be loud about
degradation.** If your brain falls back, set `fallbackUsed` / `llmPlannerDegraded`
on your response — the game records them into results and replays, so you can tell
a broken brain from a losing one. We learned why that matters the hard way; see
Section 2.

---

## Section 2 — Proof of work

This section is the honest build narrative behind Proxy War's agent: the
architecture, the Softmax integration, and a debugging story that is the whole
reason the loud-degradation rule above exists. It is deliberately conservative
about agent strength, because the agent's strength is still being validated.

### The "Keystone" architecture: a Commander and an Executor

Keystone is Proxy War's canonical agent. It is a **Commander–Executor** design
with **binding directives**, and it exists to answer one sharp question honestly:
is this just a deterministic bot in an LLM costume?

The shape:

- The **LLM Commander** makes every decision that wins or loses games — who to
  attack, when to commit decisively, who to ally, when to betray, what to signal.
  It emits a **Strategic Directive**: an objective, a target, a **commitment
  level** (probe / standard / decisive) with a minimum attack ratio and an `until`
  condition, per-rival diplomacy stances, and a communications intent. Crucially
  the commitment is a *standing order* — it carries the Commander's authority
  forward between refreshes.
- The **deterministic Executor** obeys. It turns the directive into mechanics
  (which tile, exact troop math, pathing, batching) and answers every decision
  request in-clock — **with no LLM call in the response path**, which is how the
  15-second clock is structurally satisfied. Its safety logic may adjust mechanics
  and may *request* an early Commander refresh when the situation changes, but it
  may not silently veto strategy. Override attempts are counted and are expected to
  trend to zero.
- The **Commander refreshes asynchronously** — on a cadence (roughly every 3
  decision steps) and on event triggers (an incoming attack, an alliance
  offer/break/betrayal, a leader change, a kill-window opening).

Why this shape and not the obvious alternatives? Because all three candidate
architectures were measured, and the data forced this design:

- A pure action-selector (LLM picks every move) was maximally agentic but **lost
  games** and ran dangerously close to the 15-second clock.
- A thin label-planner (LLM sets an objective, executor decides everything else)
  was fast and competitive but the consequential authority sat with the executor —
  "a bot in a costume." In one measured 9,000-turn game the LLM ordered the
  pressure objective on 337 of 341 decisions while the executor declined most of
  the attacks and the agent threw a commanding lead.

Binding directives are the fix: keep the label-planner's speed, remove its one
measured defect — the executor's power to ignore the LLM. The design goal is an
agent that is *perpetually improvable*: because every consequential decision is
model-made, a better model is a better agent with zero code changes, and prompt /
playbook iteration finally has leverage.

And the rule that ties this whole writeup together: **LLM failures degrade
loudly.** A failed or timed-out Commander call executes the last directive and
marks the run `llmPlannerDegraded` — it is never quietly replaced by a rule-bot
that looks healthy. The architecture's central honesty mechanism is that a
degraded brain is *visible*.

### The Softmax integration — first external game on the Observatory

Proxy War is the **first external game on Softmax's Observatory** league platform.
This was not a one-way port: Softmax's engineers contributed a pull request
(merged into the public `main` on 2026-06-10) that wired up native Observatory
support — serving Coworld replays through their hosted asset proxy, a browser
player overlay so a human can take a Coworld slot (still selecting only offered
`LegalAction.id`s), an extended episode runner, and the canonical tournament
manifest. The pre-merge review confirmed the agent-protocol surface was untouched
and the `LegalAction.id` contract preserved. Hosted inference for `--use-bedrock`
policies runs on Softmax's Bedrock service account (their cost, operator-confirmed),
so a policy needs no provider keys in its image.

### The debugging archaeology: a dead brain that reported healthy for ~60 rounds

This is the part worth telling, because it is embarrassing in exactly the way that
builds trust.

An early Proxy War policy, `proxywar-bedrock:v1`, sat in the live league for **more
than 60 rounds** appearing to play. Every report said it was fine: **zero
fallbacks**. It was, in fact, **a deterministic masquerade for its entire life** —
it had never once made a successful LLM decision.

Two independent bugs stacked to hide this:

1. **A retired model id.** The policy pinned `anthropic.claude-3-5-sonnet-20240620-v1:0`,
   which Bedrock had retired (end-of-life 2025-10-28). Every model call came back
   `404 This model version has reached the end of its life` — root-caused from the
   actual pod logs via the Observatory's episode debug panel. With the brain dead,
   the policy fell back to playing the first legal action plus a built-in defensive
   profile.
2. **A lying health flag.** Worse, the game-side adapter **hardcoded
   `parseSuccess: true, fallbackUsed: false`** on every wire decision. So even
   though the policy was screaming "transport fallback" on the inside, the
   artifacts dutifully reported 0 fallbacks. The failure was invisible in every
   single report.

This was the fourth incident of the same class (earlier ones: a Codex model that
was silently unsupported; a Codex run that hit its usage quota at call 21 and fell
back unnoticed; an executor overriding the LLM 337/341 times). The pattern is
always the same: a deterministic fallback that defaults *on* because it passes
every gate for free, and a missing loud-failure signal.

The fix has two halves, and both are now in the product:

- **Model-id autodetect / candidate fall-through.** The policy no longer trusts a
  single pinned id. It walks an ordered candidate list and advances *per call* — so
  a flapping or retired id falls through to the next usable model instead of dying
  silently. (A related account-side wrinkle: Bedrock requires `us.`
  inference-profile ids rather than bare model ids on this account; that's also
  handled.)
- **Degradation flags that travel end-to-end.** `fallbackUsed` / `llmPlannerDegraded`
  now ride the `decision_response` on the wire *and* get recorded into the game-side
  artifacts (replacing the hardcoded "healthy"). A dead brain can no longer look
  healthy: a fallback is recorded as a fallback, everywhere, all the way through to
  the replay.

That is why Section 1's house rule is "be loud about degradation." It is not
boilerplate — it is the scar tissue from this exact bug.

### Where agent validation actually stands — IN PROGRESS

Honest status, stated plainly:

- **Protocol and infrastructure: proven hosted.** When the corrected Keystone
  policy first ran a hosted qualifier game, it was protocol-flawless — 5,301 turns,
  **102/102 decisions accepted, 0 transport fallbacks** — where prior LLM seats had
  debuted with dozens of transport fallbacks. The wrapper's in-clock answer path
  works on the real platform. The loud-degradation channel also works end-to-end:
  in that same debut the Commander was *dark*, and 46 of 102 decisions carried
  honest degraded flags rather than pretending to be healthy.
- **The LLM brain is real, and has produced live decisions.** After the model-id
  fix, a qualifier episode's first decision was genuine Claude reasoning
  ("Highest score among all spawn options; selecting the top-ranked position…"),
  which confirmed the `us.` inference-profile fix works.
- **But the brain is currently blocked, account-side.** Subsequent calls flapped to
  `404 Model use case details have not been submitted` — Bedrock's one-time
  Anthropic use-case approval form, evidently approved in only some of the regions
  the cross-region profile routes to. Until that form clears across all routed
  regions, the Commander cannot stay awake for a full hosted game. The policy is
  resilient to it (it falls through per call and degrades loudly), but it is a real
  external block.
- **Therefore: the agent has NOT yet won a hosted game with its brain live.** It
  has been seated, has proven the protocol under real hosted conditions, and has
  demonstrated live model decisions in qualifiers — but a full Commander-alive
  hosted game, and the A/B verdict on whether binding directives actually fix the
  thrown-lead defect, are still ahead of us. The competitive question is open by
  design: qualifiers are the cheap, contained place to gather that behavior data.

<!-- TODO: keystone A/B verdict (binding-directives fix validated?) -->
<!--
     PLACEHOLDER — fill in when validation completes. The open empirical claim is:
     does the binding-directives Commander–Executor architecture convert the lead it
     previously threw (the 9,000-turn Iceland/Medium baseline loss), per the
     replicated A/B gate (overrides → 0, agentic-share high, win-rate / retention),
     in Commander-ALIVE hosted games?
     Prerequisites still outstanding at time of writing:
       - Softmax's Bedrock use-case form approved across all routed regions
         (the account-side block keeping the Commander dark);
       - the league rebound to the canonical proxywar 0.0.9 package (it currently
         runs the older 0.0.7 micro-variant, which has too few decisions per seat
         for agent skill to express).
     Until those land and the A/B runs, leave this verdict UNSTATED. Do not infer it
     from the protocol-clean debut above — a clean protocol is not a won game.
-->

---

## Claims I was unsure about / TODOs left

1. **Keystone A/B verdict — left as an explicit `TODO` placeholder** in Section 2
   (HTML comment block). The binding-directives architecture has not been validated
   in a Commander-alive hosted game, so there is no win/loss verdict to state. Per
   the tone rule, I left it blank rather than implying a result.

2. **"First external game on the Observatory."** Stated as a fact because the
   decision-log records it from Softmax's own message ("we'd be their FIRST external
   coworld") and repeats it across multiple 2026-06-10 rows. Confidence: high, but
   it rests on Softmax's claim about their own platform, not independent
   verification.

3. **"Softmax's engineers contributed a PR."** The decision-log calls it "Softmax
   PR #3 … written by Softmax's codex" and "written by Softmax's codex." I phrased
   it as "Softmax's engineers contributed a pull request." The PR being authored by
   Softmax (vs. an automated tool they run) is what the source implies; I did not
   overstate it as hand-authored line-by-line.

4. **Softmax pays Bedrock inference.** Stated as operator-confirmed (decision-log
   2026-06-10 row 124 marks it answered by the operator; the architecture doc §4
   still flagged it "payer TBC" as of 2026-06-09). I used the later, confirmed
   value. Confidence: high per the newer source.

5. **League standings deliberately omitted.** The known-problems doc records our
   seat sitting last (~0.326) after 60 rounds, but that was during the deterministic
   masquerade (brain dead), so citing it as agent performance would be misleading in
   either direction. I left competitive numbers out of the recruitment and
   proof-of-work copy on purpose; they are not a fair measure of the agent.

6. **Episode shape numbers (50 decisions × 100 turns, ~5,000 turns; 102/102; 5,301
   turns; 46/102 degraded flags).** All taken verbatim from `ENTER_THE_LEAGUE.md`
   and decision-log rows 128–130. No metrics were invented or estimated.

7. **`coworld==0.1.20` CLI pin and the league id** come straight from
   `ENTER_THE_LEAGUE.md`; I pointed readers there rather than duplicating the exact
   submit command, since the canonical entry doc may drift and should stay the
   single source.

8. **Relative link to `ENTER_THE_LEAGUE.md`.** I used `../coworld-adapter/ENTER_THE_LEAGUE.md`
   on the assumption this doc lives at `docs/`. If it's moved, fix the relative path.
