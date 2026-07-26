/**
 * Fixture loader seam — SPEC §9.
 *
 * `FixtureSource` is the seam a v2 chunked-release endpoint replaces
 * without touching feature code; v1 fills it with a bundled-JSON
 * implementation. Bundling the outcome (and full replay) client-side is
 * intentional and spec'd (§9: v1's integrity guarantee is UI-state-only,
 * not devtools-proof) — what this module *does* guard is application
 * state: view code that hasn't closed a checkpoint gets a type
 * (`FixtureBriefing`) with no `outcome` or `replay` field at all. The real
 * outcome is only reachable through `readFixtureOutcome`, and replay frames
 * only through `visibleFrames`, both gated by `CheckpointGate` and refusing
 * to reveal past what the current checkpoint state allows.
 *
 * `CheckpointGate`'s closed state must be reconstructed from
 * `PredictionStore.loadClosedCheckpoints()` on every load — never inferred
 * from stake presence. A checkpoint window the player opened, staked
 * nothing on, and watched resolve is still closed; inferring closure from
 * stakes lets a refresh reopen it with the outcome already seen.
 */
import type {
  CheckpointIndex,
  Fixture,
  FixtureId,
  FixtureOutcome,
  ReplayFrame,
} from "../types";

export interface FixtureSource {
  listFixtureIds(): Promise<readonly FixtureId[]>;
  loadFixture(id: FixtureId): Promise<Fixture>;
}

/** Every bundled fixture JSON module, keyed by file path, eagerly loaded. */
type FixtureModules = Record<string, { readonly default: Fixture }>;

/**
 * `modulesOverride` is a DI seam for tests/stubs that don't have real
 * bundled fixture files yet — inject a small hand-written map matching
 * `Fixture` instead of blocking on the real data.
 */
export function createBundledFixtureSource(
  modulesOverride?: FixtureModules,
): FixtureSource {
  const modules: FixtureModules =
    modulesOverride ??
    (import.meta.glob("../data/fixtures/*.json", {
      eager: true,
    }) as FixtureModules);

  const byId = new Map<FixtureId, Fixture>();
  for (const mod of Object.values(modules)) {
    byId.set(mod.default.id, mod.default);
  }

  return {
    async listFixtureIds() {
      return [...byId.keys()];
    },
    async loadFixture(id) {
      const fixture = byId.get(id);
      if (fixture === undefined) {
        throw new Error(`Unknown fixture id: ${id}`);
      }
      return fixture;
    },
  };
}

/**
 * The pre-reveal view of a fixture: everything except `outcome` and
 * `replay`. Typed out, not just omitted at runtime, so view code that only
 * ever sees a `FixtureBriefing` cannot read the outcome or a post-checkpoint
 * frame even by mistake — replay frames must go through `visibleFrames`
 * instead, which clips to what the gate currently allows.
 */
export type FixtureBriefing = Omit<Fixture, "outcome" | "replay">;

export function toFixtureBriefing(fixture: Fixture): FixtureBriefing {
  const { outcome: _outcome, replay: _replay, ...briefing } = fixture;
  return briefing;
}

/**
 * Tracks which checkpoints have closed for one fixture-play session. The
 * outcome is reachable only once both have — i.e. only after the reveal has
 * played past checkpoint 2, per the SPEC §4 flow.
 *
 * `initiallyClosed` hydrates a gate from a persisted record (see
 * `PredictionStore.loadClosedCheckpoints`) so a refresh cannot reopen a
 * window the player has already been shown.
 */
export class CheckpointGate {
  private readonly closed: Set<CheckpointIndex>;

  constructor(initiallyClosed: Iterable<CheckpointIndex> = []) {
    this.closed = new Set(initiallyClosed);
  }

  closeCheckpoint(index: CheckpointIndex): void {
    this.closed.add(index);
  }

  isCheckpointClosed(index: CheckpointIndex): boolean {
    return this.closed.has(index);
  }

  get isFullyRevealed(): boolean {
    return this.closed.has(0) && this.closed.has(1);
  }
}

export function readFixtureOutcome(
  fixture: Fixture,
  gate: CheckpointGate,
): FixtureOutcome {
  if (!gate.isFullyRevealed) {
    throw new Error(
      `Fixture ${fixture.id} outcome is locked until both checkpoints have closed`,
    );
  }
  return fixture.outcome;
}

/**
 * Replay frames visible under the current gate state — clipped on the way
 * out, never handed over whole for the caller to slice. Before checkpoint 0
 * closes: frames up to checkpoint 0's turn (the initial "play to checkpoint
 * 1" pass). Once checkpoint 0 has closed but checkpoint 1 hasn't: frames up
 * to checkpoint 1's turn. Once both have closed: every frame, including the
 * post-checkpoint-2 resolution.
 */
export function visibleFrames(
  fixture: Fixture,
  gate: CheckpointGate,
): readonly ReplayFrame[] {
  const frames = fixture.replay?.frames ?? [];
  if (gate.isFullyRevealed) return frames;
  const cutoffTurn = gate.isCheckpointClosed(0)
    ? fixture.checkpoints[1].turn
    : fixture.checkpoints[0].turn;
  return frames.filter((f) => f.turn <= cutoffTurn);
}
