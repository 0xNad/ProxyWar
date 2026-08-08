import { ReplayPremiereAnonymousWriteLimiter } from "../../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import {
  ReplayPremiereHttpRegistry,
  type ReplayPremiereRuntimeReader,
} from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import { ReplayPremiereInteractions } from "../../../src/server/replay-premiere/ReplayPremiereInteractions";

describe("ReplayPremiereAnonymousWriteLimiter", () => {
  test("enforces one atomic global ceiling across multiple premiere registries", async () => {
    const limiter = new ReplayPremiereAnonymousWriteLimiter({
      maxGlobalAttemptsPerWindow: 5,
      maxPremiereAttemptsPerWindow: 100,
      maxBucketAttemptsPerWindow: 100,
      maxParticipantAttemptsPerWindow: 100,
      maxSessionAttemptsPerWindow: 100,
      now: () => new Date("2026-07-20T18:00:00.000Z"),
    });
    const first = target("prem_aaaaaaaaaaaaaaaa", limiter.admit);
    const second = target("prem_bbbbbbbbbbbbbbbb", limiter.admit);
    const firstRegistry = new ReplayPremiereHttpRegistry(limiter.admit);
    const secondRegistry = new ReplayPremiereHttpRegistry(limiter.admit);
    firstRegistry.register(first);
    secondRegistry.register(second);

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => {
        const selected = index % 2 === 0 ? first : second;
        return selected.interactions.createViewerSession({
          participantId: `guest_${index.toString(16).padStart(32, "0")}`,
          idempotencyKey: `session_attempt_${index.toString().padStart(16, "0")}`,
          requesterBucketId: `ip_${index.toString(16).padStart(64, "0")}`,
          visible: true,
          observedSequence: -1,
          excludedAsOperator: false,
          excludedAsBot: false,
        });
      }),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(5);
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(15);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" && result.reason.httpStatus === 429,
      ),
    ).toBe(true);
  });

  test("registry rejects an interaction store wired to a different admission callback", () => {
    const limiter = new ReplayPremiereAnonymousWriteLimiter();
    const registry = new ReplayPremiereHttpRegistry(limiter.admit);
    expect(() =>
      registry.register(target("prem_cccccccccccccccc", () => undefined)),
    ).toThrow(/admission_mismatch/);
  });

  test("a saturated bucket cannot allocate rotating participant keys", () => {
    const limiter = new ReplayPremiereAnonymousWriteLimiter({
      maxGlobalAttemptsPerWindow: 100,
      maxPremiereAttemptsPerWindow: 100,
      maxBucketAttemptsPerWindow: 2,
      maxParticipantAttemptsPerWindow: 100,
      maxSessionAttemptsPerWindow: 100,
      maxTrackedKeys: 100,
      now: () => new Date("2026-07-20T18:00:00.000Z"),
    });
    const request = (participant: number, bucket: number) => ({
      route: "session" as const,
      premiereId: "prem_aaaaaaaaaaaaaaaa",
      participantId: `guest_${participant.toString(16).padStart(32, "0")}`,
      sessionId: null,
      requesterBucketId: `ip_${bucket.toString(16).padStart(64, "0")}`,
      idempotencyKey: `session_attempt_${participant.toString().padStart(16, "0")}`,
      occurredAt: "2026-07-20T18:00:00.000Z",
      currentPremiereRecordCount: 0,
    });
    limiter.admit(request(1, 1));
    limiter.admit(request(2, 1));
    const saturatedKeyCount = limiter.readTrackedKeyCount();
    for (let participant = 3; participant < 2_003; participant += 1) {
      expect(() => limiter.admit(request(participant, 1))).toThrow();
    }
    expect(limiter.readTrackedKeyCount()).toBe(saturatedKeyCount);
    expect(() => limiter.admit(request(3_000, 2))).not.toThrow();
  });
});

function target(
  premiereId: string,
  admitAnonymousWrite: ConstructorParameters<
    typeof ReplayPremiereInteractions
  >[0]["admitAnonymousWrite"],
) {
  let randomByte = 1;
  const interactions = new ReplayPremiereInteractions({
    premiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 10 },
      { id: "cp_second001", sequence: 20 },
    ],
    seats: [
      {
        seatId: "seat-1",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "test",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: "seat-2",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "test-2",
          declaredVersion: "1",
          manifestSha256: "3".repeat(64),
          contentSha256: "4".repeat(64),
        },
      },
    ],
    getPremiereState: () => "scheduled",
    getReleasedContext: () => null,
    persistence: { async persist() {} },
    signAttribution: () => "unused",
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date("2026-07-20T18:00:00.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
    admitAnonymousWrite,
  });
  const runtime = {
    premiereId,
    readLifecycleState: () => "scheduled",
    readBootstrap: () => {
      throw new Error("unused");
    },
    readManifest: () => {
      throw new Error("unused");
    },
    readChunk: () => null,
    readReveal: () => null,
    readReleasedContext: () => null,
    readLiveVisibleSequence: () => -1,
    readLiveProjection: () => [],
  } as ReplayPremiereRuntimeReader;
  return { runtime, interactions };
}
