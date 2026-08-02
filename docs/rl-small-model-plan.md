# RL-Training a Small Model to Play Proxy War — Execution Plan

Date: 2026-07-04. Status: PLAN (operator-initiated exploration; no code landed yet).
Audience: the Claude Code instance on the operator's Windows PC (WSL2), which drives
Phases 0/2/3/4, and the Mac-side Control session, which can build Phase 1 in-repo.
This doc is self-contained because `docs/project-state/` is gitignored and will NOT
arrive with a repo bundle.

Facts below marked [verified 2026-07-04] came from primary-source web research on
that date. Re-verify anything version-shaped before relying on it — this ecosystem
moves monthly.

---

## 0. Goal and honest expectations

Train a small open LLM (4B class) with SFT + GRPO to play Proxy War (OpenFront
fork) as a policy that picks one offered `LegalAction.id` per decision step.

What this buys even if RL play underwhelms:
- A fast headless gym + parallel-episode eval harness (this IS roadmap priority
  "fast, reproducible evaluation loop against actual opponents").
- A zero-marginal-cost, millisecond-latency seat that is structurally immune to
  Coworld's 20-minute hosted episode deadline (inline-LLM seats die at ~50–80
  decisions; this policy decides in ~100ms).
- A sparring partner to evaluate Keystone against at scale (thousands of games).

Expected competitive ceiling (calibrated, not promised): after ~1–2 weeks of
local runs, reliably beats Easy/Medium built-in nations and the rule starter at
the trained short variant; plausibly competitive vs Hard nations in-distribution;
does NOT match Claude-driven Keystone in novel political situations and will
overfit its training opponent pool unless diversity is enforced. It is a separate
policy lineage, not a Keystone replacement.

Deployment reality: hosted Coworld policy pods are CPU-only, ~1GB-class. A 4B
bf16 model cannot be seated hosted. Paths later (all operator-gated): distill to
~0.6B + Q4 CPU inference, remote-serve via pod egress (egress unverified), or
keep it local-only. Do not promise a hosted seat.

## 1. Non-negotiable invariants (same as the whole repo)

- Canonical path only: `AgentObservation -> LegalAction[] -> AgentDecision ->
  AgentDecisionValidator -> AgentRunner -> GameServer`. The RL seat is an
  `AgentBrain` implementation that returns one OFFERED `LegalAction.id`. No raw
  intents, no second validator, no second runner, no new action schema.
- No LLM/provider/network logic in `src/core` (deterministic sim). The gym
  server is server-side (`src/server/agents/...`), like SimRollout.ts.
- The trained model is an LLM brain (a learned policy). Never silently fall back
  to the deterministic executor when it fails — fail loud, mirror the
  `llmPlannerDegraded` convention. Rule/built-in brains ARE allowed as training
  OPPONENTS; they are never "the agent."
- Training data for imitation comes from `planner-claude-cli` / bedrock Keystone
  games only (filter `decisions.jsonl` on `brainType`), never rule-brain games.
- Outward actions stay gated: pushing branches/main, any Coworld hosted
  mutation, and publishing the env to Prime Intellect's Environments Hub all
  need explicit operator approval. Hub publication also has a strategic-optics
  question (PI's hub is adjacent to Softmax/Coworld territory) — operator call.

## 2. What already exists in the repo (reuse, don't rebuild)

- `src/server/agents/SimRollout.ts` — proves the pattern this plan needs:
  snapshot a game as `{gameStartInfo, turns}`, replay into a fresh `GameRunner`,
  step the deterministic sim forward headlessly, byte-for-byte reproducible.
  The gym server is "SimRollout, but interactive."
- The in-process league match runner (what `ai-agent-league-smoke.ts` drives)
  runs full games with pluggable `AgentBrain`s. Wrap it; do not write a runner.
- `coworld-adapter/src/keystone-player.ts` — the Coworld ws player protocol
  (`observation + LegalAction[] -> selectedLegalActionId`) and the deferred-
  planning pattern. The gym protocol should mirror this shape.
- Artifacts as SFT data: every run dir has `decisions.jsonl` (per-decision:
  `brainType`, `legalActionIDsByKind`, `selectedLegalActionId`,
  `observationSummary`, `strategicSummary`) and `game-record.json`
  (`{gameStartInfo, turns}` — deterministic replay lets you REBUILD the full
  `AgentObservation + LegalAction[]` at every decision step offline). ~240
  decisions per ffa4p game.
- Perf facts: sim does ~3,000 turns in ~26s per process; keep training cells at
  4p (AgentObservationBuilder blows up at high player counts — known problem);
  ffa4p / duel2p are the SOP cells.

## 3. Hardware / software ground truth [verified 2026-07-04]

Target box: Ryzen 7 9800X3D (8c/16t), 64GB RAM, RTX 5090 32GB (sm_120), Win 11.

- WSL2 Ubuntu 24.04 is the platform. Native Windows is not viable for the RL
  stack (vLLM/FSDP/Triton are Linux toolchains).
- PyTorch stable 2.12.x (cu130 default) supports sm_120; anything ≥2.7/cu128
  works. Let vLLM/Unsloth pin their own torch (`uv pip install vllm
  --torch-backend=auto`; Unsloth's Blackwell guide standardizes cu128).
- vLLM ≥0.17 runs 5090 out of the box (current 0.24). Attention: FlashInfer is
  the practical best on sm_120; FA3/FA4 do not cover desktop Blackwell. Never
  install the `flash-attn` pip package — no sm_120 wheels; Unsloth/vLLM don't
  need it.
- WSL2 gotchas that matter:
  - fp8 WEIGHTS are crippled under WSL2 (paravirtual driver lacks the native
    FP8 GEMM path; 3× slower than AWQ in a Mar 2026 benchmark). Use bf16 (or
    AWQ/GPTQ for inference-only). fp8 KV-cache is probably fine (unbenchmarked).
  - CUDA graphs work since WSL 2.7.0 and are worth ~8× decode throughput —
    never run vLLM `--enforce-eager` except to debug.
  - `.wslconfig` on Windows: `memory=48GB`, `processors=14`, some swap. Keep
    ALL code/data on ext4 (`~/`), never `/mnt/c`.
  - Windows NVIDIA driver only; never install a Linux driver inside WSL.
  - Expect ~5–15% penalty vs native Linux. Acceptable; dual-boot Ubuntu is the
    escape hatch if it compounds.
- For multi-day runs: power-limit the card from WINDOWS (`nvidia-smi -pl 450`)
  — memory-bound RL loses almost nothing at 450W and thermals/noise improve.
- Memory envelope for GRPO with trainer + vLLM colocated on 32GB:
  full-parameter tops out ~1.7B; LoRA bf16 4B is easy (~10–14GB), 8–9B LoRA
  comfortable, 14B QLoRA is the ceiling. 4B LoRA is the sweet spot.

## 4. Model choice [verified 2026-07-04]

- PRIMARY: `Qwen/Qwen3-4B-Instruct-2507`. Apache 2.0, classic transformer (full
  vLLM + LoRA + Unsloth + prime-rl support), non-thinking (predictable episode
  token counts), the size RL stacks are tested against.
- PIPELINE-DEBUG: `Qwen/Qwen3-1.7B` (prime-rl's own Wordle example model).
- NOT YET: Qwen3.5-4B — better model, but its Gated-DeltaNet hybrid attention
  forfeits vLLM-backed rollouts in RL trainers today (Unsloth: RL only with
  `fast_inference=False`), which is the single biggest wall-clock win. Adopt
  when the stacks absorb it. NOT thinking-mode models (5–20× episode tokens for
  marginal gain on action selection). NOT gpt-oss-20b (no vLLM RL path, ~21
  tok/s rollouts). Gemma 4 unverified in RL stacks.
- Later distill target for the CPU-pod experiment: Qwen3-0.6B.
- Completion format: action id + one short rationale line, ≤~128 tokens.

## 5. Trainer strategy [verified 2026-07-04]

Build the environment as a **verifiers** `MultiTurnEnv` (pin `verifiers==0.1.14`
— API churns monthly). This is trainer-agnostic leverage: prime-rl consumes
verifiers envs natively; `prime eval run` evaluates ANY OpenAI-compatible
endpoint (including hosted frontier models and the local vLLM) against the same
env; the episode-level `Rubric` is exactly the game-reward shape.

Trainer order of attack on one 5090:
1. **prime-rl v0.6.x** — the RTX 5090 is on its official tested-hardware list;
   single-GPU colocated RL landed (PR #971: same GPU id for trainer+inference,
   cap `gpu-memory-utilization` ~0.45–0.55); LoRA is first-class; multi-turn
   examples exist (Wordle, alphabet-sort). Caveats: disaggregated 2-GPU is its
   design center; single-GPU is treated as debug-grade; zero official WSL2
   support statements. Try it first because it's zero adapter code.
2. **TRL v1.0 GRPOTrainer** with `vllm_mode="colocate"` + `rollout_func` (you
   own the episode loop against the gym server) — canonical fallback.
3. **OpenPipe ART** — purpose-built multi-turn agent GRPO (Unsloth+vLLM+LoRA
   under the hood), OpenAI-compatible rollout loop; fastest path if 1 and 2
   fight; watch that local mode stays maintained (they push serverless).

The Node gym server and reward logic are identical across all three; only the
Python glue changes (~a day to rewire).

Wall-clock calibration: ~30-decision episodes, ~1–2k prompt tokens/turn, groups
of 8–16 → roughly 2–4 min per GRPO step, 350–700 steps/day sustained; published
game-RL runs show meaningful reward movement in 100–500 steps. Comparable
precedent: OpenPipe trained a 14B multi-turn agent on 1×H100 in under a day
(~$80). Long variants (100+ decisions, 3k-token obs) → plan 100–200 steps/day.

## 6. Phases and acceptance gates

### Phase 0 — Windows box prep (Windows Claude, ~half a day)
1. WSL2 Ubuntu 24.04 + `.wslconfig` (above). Verify `nvidia-smi` inside WSL and
   WSL version ≥2.7 (`wsl --version` on the Windows side).
2. Inside WSL: git, `uv`, Python 3.12, Node 24 via nvm, Claude Code
   (`npm i -g @anthropic-ai/claude-code`) + login.
3. Repo transfer: on the Mac, `git bundle create proxywar.bundle main
   claude/coworld-keystone-policy` → copy to the PC → clone from the bundle.
   (The keystone branch is local-only; a bundle avoids publishing it to the
   public origin. Copy THIS doc over manually too — it's untracked.)
4. Smoke: `npm run inst`, `npm exec -- tsc --noEmit`,
   `npx vitest tests/server/SimRollout.test.ts --run`.
GATE: a full rule-brain 4p game runs headless to completion on the PC.

### Phase 1 — Node gym server (can be built on the Mac, in-repo)
- New: `src/server/agents/rl/RlGymServer.ts` (+ tests in `tests/server/`).
  HTTP: `POST /episodes` {cell, seed, opponents, turnsPerStep, maxDecisionSteps}
  → {episodeId, observation, legalActions}; `POST /episodes/:id/step`
  {selectedLegalActionId} → {observation, legalActions, done, tileShare, winner};
  `DELETE /episodes/:id`. Internally: the existing in-process match runner; the
  RL seat is a `PendingDecisionBrain implements AgentBrain` that parks each
  decision on a promise until the HTTP step arrives. Additive only.
- Parallelism: the sim is single-threaded JS → run N server processes (ports
  9301..930N) or a small worker pool; 6–8 on the 9800X3D.
- Opponents config: built-in nations (Easy/Medium/Hard) and rule-executor
  brains, sampled per episode.
GATE: (a) 1,000-turn 4p episode round-trips in <30s; (b) same seed + same
actions → byte-identical outcome twice; (c) a random-legal-action client plays
500 episodes with zero validator rejections and zero leaked processes.

### Phase 2 — verifiers env + SFT warm start (Windows Claude)
- Python package `proxywar-env` (via `prime env init`): `MultiTurnEnv` whose
  `env_response` steps the gym server; compact observation template built for a
  4B (~800–1,500 tokens: self stats, rivals, diplomacy, threats, action menu
  with ids — do NOT reuse the full Keystone prompt); parse action id with one
  retry on invalid output; `Rubric` = final tile share + win bonus; log
  illegal-action rate as a weight-0 metric.
- Baselines with `prime eval run` against: stock Qwen3-4B, the rule policy (as
  a scripted client), and optionally a frontier model. Record scores — this is
  the eval ladder.
- SFT dataset: filter artifact runs to LLM-brain games; rebuild full
  observations by replaying `game-record.json` (SimRollout-style) at each
  logged decision; render through the SAME template; label =
  `selectedLegalActionId` (+ short rationale from `strategicSummary`). Target
  ≥3–5k examples; top up by running more local Keystone (claude-cli) games if
  short. Hold out whole GAMES (not decisions) for eval.
- Train LoRA SFT (Unsloth) on Qwen3-4B-Instruct-2507.
GATE: held-out top-1 action match ≥~50%; env-eval score clearly above stock
Qwen3-4B; 2–3 rendered replays watched and sane.

### Phase 3 — GRPO (Windows Claude, days of wall-clock)
- Validate plumbing with Qwen3-1.7B + tiny episodes end-to-end first.
- Real runs: Qwen3-4B SFT checkpoint, LoRA, bf16, FlashInfer, CUDA graphs on,
  vLLM mem-util ~0.5, episodes 30–60 decisions × 25 turns, group 8–16, mixed
  opponent sampling, fixed held-out seed+opponent eval set every ~50 steps.
- Watch for reward hacking (degenerate all-in rushes, emoji-spam if social
  actions score) — inspect replays, not just curves; adjust rubric.
GATE: beats the SFT checkpoint AND the rule-policy reference on held-out
seeds/opponents at the trained variant, with ≥100-game evals.

### Phase 4 — honest evaluation + iteration
- Ladder report: stock < SFT < RL?, vs Easy/Medium/Hard, rule starter, and a
  small quota-aware set vs Claude Keystone. Win rate + mean tile share, N,
  seeds. Then: longer variants, map/opponent diversity, curriculum.

### Phase 5 — deployment decisions (ALL operator-gated)
- Immediately useful locally: league opponent + Keystone sparring/eval partner.
- Hosted seat: research track only (distill 0.6B + Q4 CPU, or pod-egress
  serving — both unproven). PI Environments Hub publication: operator strategic
  call. PI compute marketplace (H100 ~$2.43/hr on-demand, ~$0.94 spot) is the
  scale-up path if 32GB starts binding — same verifiers env, rent 2 GPUs, run
  prime-rl disaggregated.

## 7. Budget expectations

Local training cost ≈ electricity (~200 kWh ≈ $30–60 for two weeks of runs).
Claude quota is spent only on SFT data-gen games. First honest RL result:
~1–2 weeks calendar part-time, of which the pipeline (Phases 1–2) is most of
the engineering and GRPO is mostly waiting.
