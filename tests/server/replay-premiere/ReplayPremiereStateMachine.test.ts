import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  assertValidPremiereLifecycleSnapshot,
  createDraftPremiereLifecycle,
  recordSafeReleasedSequence,
  transitionPremiereLifecycle,
  type PremiereLifecycleSnapshot,
  type PremiereTransitionRequest,
} from "../../../src/server/replay-premiere/ReplayPremiereStateMachine";
import {
  NOW,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

describe("ReplayPremiere lifecycle cancellation and archival", () => {
  let root: string;
  let fixture: Awaited<ReturnType<typeof verifiedPublicationFixture>>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-lifecycle-"));
    fixture = await verifiedPublicationFixture(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("archives an ineligible draft cancellation without inventing a source binding", () => {
    const draft = createDraftPremiereLifecycle({
      premiereId: PREMIERE_ID,
      createdAt: at(0),
    });
    const cancelled = transitionPremiereLifecycle(draft, {
      action: "cancel",
      actor: "operator",
      occurredAt: at(1),
      reasonCode: "source_ineligible",
    });

    expect(cancelled.snapshot).toMatchObject({
      state: "cancelled",
      eligibilityRecordHash: null,
      publicationCommitmentHash: null,
      sourceRunId: null,
      sourceReplaySha256: null,
      lastSafeReleasedSequence: -1,
      terminalReasonCode: "source_ineligible",
      version: 1,
    });
    expect(cancelled.auditEvent).toMatchObject({
      action: "cancel",
      fromState: "draft",
      toState: "cancelled",
      actor: "operator",
      terminalReasonCode: "source_ineligible",
    });
    expect(() =>
      assertValidPremiereLifecycleSnapshot(cancelled.snapshot),
    ).not.toThrow();

    const archived = transitionPremiereLifecycle(cancelled.snapshot, {
      action: "archive",
      actor: "service",
      occurredAt: at(2),
    });
    expect(archived.snapshot).toMatchObject({
      state: "archived",
      terminalReasonCode: "source_ineligible",
      lastSafeReleasedSequence: -1,
      version: 2,
    });
    expect(archived.auditEvent).toMatchObject({
      action: "archive",
      fromState: "cancelled",
      toState: "archived",
      actor: "service",
      terminalReasonCode: "source_ineligible",
    });
    expect(() =>
      assertValidPremiereLifecycleSnapshot(archived.snapshot),
    ).not.toThrow();
  });

  test("preserves the immutable publication binding through scheduled cancellation and archive", () => {
    const scheduled = scheduledLifecycle();
    const cancelled = transitionPremiereLifecycle(scheduled, {
      action: "cancel",
      actor: "operator",
      occurredAt: at(1),
      reasonCode: "cancelled_by_operator",
    });

    expect(cancelled.snapshot).toMatchObject({
      state: "cancelled",
      eligibilityRecordHash: scheduled.eligibilityRecordHash,
      publicationCommitmentHash: scheduled.publicationCommitmentHash,
      sourceRunId: scheduled.sourceRunId,
      sourceReplaySha256: scheduled.sourceReplaySha256,
      lastSafeReleasedSequence: -1,
      terminalReasonCode: "cancelled_by_operator",
    });
    expect(cancelled.auditEvent).toMatchObject({
      action: "cancel",
      fromState: "scheduled",
      toState: "cancelled",
      eligibilityRecordHash: scheduled.eligibilityRecordHash,
      publicationCommitmentHash: scheduled.publicationCommitmentHash,
      sourceRunId: scheduled.sourceRunId,
      sourceReplaySha256: scheduled.sourceReplaySha256,
      terminalReasonCode: "cancelled_by_operator",
    });
    expect(() =>
      assertValidPremiereLifecycleSnapshot(cancelled.snapshot),
    ).not.toThrow();

    const archived = transitionPremiereLifecycle(cancelled.snapshot, {
      action: "archive",
      actor: "operator",
      occurredAt: at(2),
    });
    expect(archived.snapshot).toMatchObject({
      state: "archived",
      eligibilityRecordHash: scheduled.eligibilityRecordHash,
      publicationCommitmentHash: scheduled.publicationCommitmentHash,
      sourceRunId: scheduled.sourceRunId,
      sourceReplaySha256: scheduled.sourceReplaySha256,
      lastSafeReleasedSequence: -1,
      terminalReasonCode: "cancelled_by_operator",
    });
    expect(() =>
      assertValidPremiereLifecycleSnapshot(archived.snapshot),
    ).not.toThrow();
  });

  test("archives a checkpoint failure while freezing the last safe sequence and source binding", () => {
    let lifecycle = transitionPremiereLifecycle(scheduledLifecycle(), {
      action: "start",
      actor: "service",
      occurredAt: at(1),
      serviceReady: true,
    }).snapshot;
    lifecycle = recordSafeReleasedSequence(lifecycle, 0, at(2));
    lifecycle = transitionPremiereLifecycle(lifecycle, {
      action: "open_checkpoint",
      actor: "service",
      occurredAt: at(3),
    }).snapshot;
    const failed = transitionPremiereLifecycle(lifecycle, {
      action: "fail",
      actor: "service",
      occurredAt: at(4),
      reasonCode: "runtime_failure",
    });

    expect(failed.snapshot).toMatchObject({
      state: "failed",
      lastSafeReleasedSequence: 0,
      terminalReasonCode: "runtime_failure",
      publicationCommitmentHash: lifecycle.publicationCommitmentHash,
    });
    const archived = transitionPremiereLifecycle(failed.snapshot, {
      action: "archive",
      actor: "service",
      occurredAt: at(5),
    });
    expect(archived.snapshot).toMatchObject({
      state: "archived",
      lastSafeReleasedSequence: 0,
      terminalReasonCode: "runtime_failure",
      publicationCommitmentHash: lifecycle.publicationCommitmentHash,
    });
    expect(archived.auditEvent).toMatchObject({
      action: "archive",
      fromState: "failed",
      toState: "archived",
      lastSafeReleasedSequence: 0,
      terminalReasonCode: "runtime_failure",
    });
    expect(() =>
      assertValidPremiereLifecycleSnapshot(archived.snapshot),
    ).not.toThrow();
    expect(() =>
      recordSafeReleasedSequence(archived.snapshot, 1, at(6)),
    ).toThrow(/release_not_permitted_in_current_state/);
  });

  test("rejects cancellation after playback and rejects archive before a terminal state", () => {
    const scheduled = scheduledLifecycle();
    const playing = transitionPremiereLifecycle(scheduled, {
      action: "start",
      actor: "service",
      occurredAt: at(1),
      serviceReady: true,
    }).snapshot;

    expect(() =>
      transitionPremiereLifecycle(playing, {
        action: "cancel",
        actor: "operator",
        occurredAt: at(2),
        reasonCode: "cancelled_by_operator",
      }),
    ).toThrow(/invalid_transition_playing_cancel/);
    expect(() =>
      transitionPremiereLifecycle(scheduled, {
        action: "archive",
        actor: "operator",
        occurredAt: at(1),
      }),
    ).toThrow(/invalid_transition_scheduled_archive/);
  });

  test("enforces runtime actor and cancellation-reason authority", () => {
    const draft = createDraftPremiereLifecycle({
      premiereId: PREMIERE_ID,
      createdAt: at(0),
    });
    const serviceCancellation = {
      action: "cancel",
      actor: "service",
      occurredAt: at(1),
      reasonCode: "cancelled_by_operator",
    } as unknown as PremiereTransitionRequest;
    expect(() =>
      transitionPremiereLifecycle(draft, serviceCancellation),
    ).toThrow(/unauthorized_cancel_actor/);

    const scheduled = scheduledLifecycle();
    expect(() =>
      transitionPremiereLifecycle(scheduled, {
        action: "cancel",
        actor: "operator",
        occurredAt: at(1),
        reasonCode: "source_ineligible",
      }),
    ).toThrow(/source_ineligible_after_publish/);
  });

  test("rejects recovered source-ineligible terminal states with a publication binding", () => {
    const scheduled = scheduledLifecycle();
    const impossibleCancelled: PremiereLifecycleSnapshot = {
      ...scheduled,
      state: "cancelled",
      terminalReasonCode: "source_ineligible",
      lastSafeReleasedSequence: -1,
      version: scheduled.version + 1,
      updatedAt: at(1),
    };
    expect(() =>
      assertValidPremiereLifecycleSnapshot(impossibleCancelled),
    ).toThrow(/invalid_lifecycle_state_semantics/);

    const impossibleArchived: PremiereLifecycleSnapshot = {
      ...impossibleCancelled,
      state: "archived",
      version: impossibleCancelled.version + 1,
      updatedAt: at(2),
    };
    expect(() =>
      assertValidPremiereLifecycleSnapshot(impossibleArchived),
    ).toThrow(/invalid_lifecycle_state_semantics/);
  });

  function scheduledLifecycle(): PremiereLifecycleSnapshot {
    const draft = createDraftPremiereLifecycle({
      premiereId: PREMIERE_ID,
      createdAt: at(0),
    });
    return transitionPremiereLifecycle(draft, {
      action: "publish",
      actor: "operator",
      occurredAt: at(0),
      gate: fixture.gate,
    }).snapshot;
  }
});

function at(offsetSeconds: number): string {
  return new Date(NOW.getTime() + offsetSeconds * 1_000).toISOString();
}
