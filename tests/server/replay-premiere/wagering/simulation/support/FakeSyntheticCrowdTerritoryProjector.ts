/**
 * Test-only double for `SyntheticCrowdTerritoryProjector`. Resolves with a
 * canned table instead of running the real game engine — `SyntheticCrowdLiveDriver`
 * treats `gate`/`drafts` as fully opaque pass-through values (it never
 * reads their fields itself, only forwards them to the projector), so
 * fake placeholder instances are safe here; real-engine integration is
 * covered separately in `SyntheticCrowdTerritoryProjection.test.ts`.
 */
import type { PremiereChunkDraft } from "../../../../../../src/server/replay-premiere/ReplayPremiereContracts";
import type { VerifiedPremiereEligibilityGate } from "../../../../../../src/server/replay-premiere/ReplayPremierePublication";
import type {
  SyntheticCrowdTerritoryProjector,
  SyntheticCrowdTerritoryTable,
} from "../../../../../../src/server/replay-premiere/wagering/simulation/SyntheticCrowdTerritoryProjection";

/** Opaque to the driver — never inspected, only forwarded to `project()`. */
export const FAKE_GATE = {} as unknown as VerifiedPremiereEligibilityGate;
export const FAKE_DRAFTS: readonly PremiereChunkDraft[] = [];

export class FakeSyntheticCrowdTerritoryProjector implements SyntheticCrowdTerritoryProjector {
  private readonly table: SyntheticCrowdTerritoryTable;
  private readonly delayMs: number;
  callCount = 0;

  constructor(table: SyntheticCrowdTerritoryTable, delayMs = 0) {
    this.table = table;
    this.delayMs = delayMs;
  }

  async project(): Promise<SyntheticCrowdTerritoryTable> {
    this.callCount += 1;
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.table;
  }
}

export class FailingSyntheticCrowdTerritoryProjector implements SyntheticCrowdTerritoryProjector {
  async project(): Promise<SyntheticCrowdTerritoryTable> {
    throw new Error("territory projection failed");
  }
}

/** Never resolves or rejects — simulates a stalled whole-match precompute (e.g. starved of CPU on a loaded box) for as long as the test cares to observe it. */
export class NeverResolvingSyntheticCrowdTerritoryProjector implements SyntheticCrowdTerritoryProjector {
  project(): Promise<SyntheticCrowdTerritoryTable> {
    return new Promise<SyntheticCrowdTerritoryTable>(() => {});
  }
}
