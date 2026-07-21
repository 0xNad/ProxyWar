import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  canonicalReplayPremiereJson,
  hashCanonicalJson,
  REPLAY_PREMIERE_REVEAL_FETCH_CONCURRENCY,
  ReplayPremiereNetworkController,
  ReplayPremiereNetworkError,
  sha256Hex,
  verifyReplayPremiereAuthoritativeResult,
  type ReplayPremiereChunkDescriptor,
  type ReplayPremierePreRevealManifest,
  type ReplayPremiereProvenance,
  type ReplayPremiereRevealWire,
} from "../../src/client/ReplayPremiereNetwork";
import { ReplayPremierePlaybackController } from "../../src/client/ReplayPremierePlayback";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import type { GameStartInfo, Turn } from "../../src/core/Schemas";
import type { ReleasedPremiereChunk } from "../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  createPremierePublicBootstrap,
  createPremiereRevealPointer,
  createPremiereRevealResponse,
  toPremierePublicChunkResponse,
} from "../../src/server/replay-premiere/ReplayPremiereWire";
import {
  verifiedLongPublicationFixture,
  verifiedPublicationFixture,
} from "../server/replay-premiere/ReplayPremiereFixtures";

const PREMIERE_ID = "prem_0123456789abcdef";
const ZERO_HASH = "0".repeat(64);
const ONE_HASH = "1".repeat(64);
const SOURCE_HASH = "a".repeat(64);
const CREATED_AT = "2026-07-20T18:00:00.000Z";
const STARTED_AT = "2026-07-20T18:00:10.000Z";
const SERVER_NOW = "2026-07-20T18:00:20.000Z";
const RELEASED_AT = "2026-07-20T18:00:12.000Z";
let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "premiere-client-wire-"),
  );
});

afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

interface ReleasedRecord {
  sequence: number;
  turn: number;
  presentationOffsetMs: number;
  payload: Turn;
}

interface PublicChunk extends ReplayPremiereChunkDescriptor {
  schemaVersion: 1;
  provenance: ReplayPremiereProvenance;
  records: ReleasedRecord[];
}

function gameStartInfo(): GameStartInfo {
  return {
    gameID: "PREM0001",
    lobbyCreatedAt: 10,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: [
      {
        clientID: "SEAT0001",
        username: "Alpha",
        clanTag: null,
      },
      {
        clientID: "SEAT0002",
        username: "Beta",
        clanTag: null,
      },
    ],
  };
}

function baseProvenance(eligibilityRecordHash = ZERO_HASH) {
  return {
    sourceKind: "controlled_exhibition",
    sourceRunId: "run_001",
    coworld: null,
    sourceReplaySha256: SOURCE_HASH,
    seats: [
      {
        seatId: "seat_0",
        displayName: "Alpha",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "v1",
          manifestSha256: "c".repeat(64),
          contentSha256: "d".repeat(64),
        },
      },
      {
        seatId: "seat_1",
        displayName: "Beta",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "beta",
          declaredVersion: "v2",
          manifestSha256: "e".repeat(64),
          contentSha256: "f".repeat(64),
        },
      },
    ],
    publicLabel: "premiere",
    eligibilityRecordHash,
  } as const;
}

function provenance(
  eligibilityRecordHash: string,
  publicationCommitmentHash: string,
): ReplayPremiereProvenance {
  return {
    ...baseProvenance(eligibilityRecordHash),
    seats: baseProvenance(eligibilityRecordHash).seats.map((seat) => ({
      ...seat,
      policyIdentity: { ...seat.policyIdentity },
    })),
    publicationCommitmentHash,
  };
}

function records(...turnNumbers: number[]): ReleasedRecord[] {
  return turnNumbers.map((turnNumber, index) => ({
    sequence: index,
    turn: turnNumber,
    presentationOffsetMs: index * 500,
    payload: { turnNumber, intents: [] },
  }));
}

async function buildChunk(options: {
  index: number;
  records: ReleasedRecord[];
  previousChunkHash: string | null;
  terminal?: boolean;
  releasedAt?: string;
  provenance?: ReplayPremiereProvenance;
}): Promise<PublicChunk> {
  const payload = { schemaVersion: 1 as const, records: options.records };
  const payloadBytes = canonicalJsonBytes(payload);
  const descriptorWithoutHash = {
    premiereId: PREMIERE_ID,
    index: options.index,
    startSequence: options.records[0].sequence,
    endSequence: options.records[options.records.length - 1].sequence,
    startTurn: options.records[0].turn,
    endTurn: options.records[options.records.length - 1].turn,
    presentationOffsetMs:
      options.records[options.records.length - 1].presentationOffsetMs,
    previousChunkHash: options.previousChunkHash,
    payloadHash: await sha256Hex(payloadBytes),
    byteLength: payloadBytes.byteLength,
    terminal: options.terminal ?? false,
    releasedAt: options.releasedAt ?? RELEASED_AT,
  };
  return {
    schemaVersion: 1,
    ...descriptorWithoutHash,
    chunkHash: await hashCanonicalJson(descriptorWithoutHash),
    provenance: options.provenance ?? (await bootstrap()).provenance,
    records: options.records,
  };
}

function descriptor(chunk: PublicChunk): ReplayPremiereChunkDescriptor {
  const {
    schemaVersion: _schemaVersion,
    provenance: _provenance,
    records: _records,
    ...value
  } = chunk;
  return value;
}

async function manifest(
  chunks: PublicChunk[] = [],
  overrides: Partial<ReplayPremierePreRevealManifest> = {},
): Promise<ReplayPremierePreRevealManifest> {
  const last = chunks[chunks.length - 1];
  const defaultProvenance =
    chunks[0]?.provenance ?? (await bootstrap()).provenance;
  return {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "playing",
    serverNow: SERVER_NOW,
    scheduledAt: CREATED_AT,
    actualStartAt: STARTED_AT,
    playbackRate: 2,
    authoritativeElapsedMs: 1_000,
    accumulatedPauseMs: 0,
    releasedThroughSequence: last?.endSequence ?? -1,
    lastReleasedChunkIndex: last?.index ?? -1,
    activeCheckpoint: null,
    provenance: defaultProvenance,
    releasedChunks: chunks.map(descriptor),
    ...overrides,
  };
}

async function bootstrap(eligibilityRecordHash = ZERO_HASH) {
  const startInfo = gameStartInfo();
  const base = baseProvenance(eligibilityRecordHash);
  const publicDefinition = {
    title: "Alpha vs Beta",
    spoilerNeutralDescription: "A controlled ProxyWar exhibition.",
    map: { id: String(GameMapType.Asia), label: "Asia" },
    matchFormat: { id: "ffa-2", label: "Two-seat FFA", seatCount: 2 },
    scheduledAt: CREATED_AT,
    playbackRate: 2 as const,
    checkpoints: [
      { id: "cp_00000001", sequence: 2 },
      { id: "cp_00000002", sequence: 4 },
    ] as const,
    provenance: base,
  };
  const commitmentPreimage = {
    schemaVersion: 1 as const,
    commitmentKind: "replay_premiere_publication_v1" as const,
    premiereId: PREMIERE_ID,
    eligibilityRecordHash,
    sourceRunId: base.sourceRunId,
    sourceReplaySha256: base.sourceReplaySha256,
    gameStartInfoHash: await hashCanonicalJson(startInfo),
    publicDefinitionHash: await hashCanonicalJson(publicDefinition),
    playbackRate: publicDefinition.playbackRate,
    checkpoints: publicDefinition.checkpoints,
    maxPresentationSpanMs: 1_000,
    finalSequence: 5,
    chunkCount: 3,
    terminalPrepublicationRoot: "8".repeat(64),
    orderedDraftManifestRoot: "9".repeat(64),
  };
  const publicationCommitmentHash = await hashCanonicalJson(commitmentPreimage);
  return {
    schemaVersion: 1 as const,
    premiereId: PREMIERE_ID,
    gameStartInfo: startInfo,
    gameStartInfoHash: commitmentPreimage.gameStartInfoHash,
    publicDefinition: {
      ...publicDefinition,
      checkpoints: [...publicDefinition.checkpoints],
    },
    publicationCommitmentHash,
    provenance: provenance(eligibilityRecordHash, publicationCommitmentHash),
    integrityScope: {
      publicationCommitment: "anchored_server_enforced" as const,
      sourceReplay: "declared_hash_only" as const,
      authoritativeResult: "not_revealed" as const,
    },
  };
}

function jsonResponse(
  value: unknown,
  options: { status?: number; noStore?: boolean; contentType?: string } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json; charset=utf-8",
      ...(options.noStore === false ? {} : { "cache-control": "no-store" }),
    },
  });
}

function queuedFetch(...responses: Array<Response | Error>) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    if (response instanceof Error) throw response;
    return response;
  });
}

function controller(
  fetchImpl: typeof fetch,
  callbacks: ConstructorParameters<
    typeof ReplayPremiereNetworkController
  >[0]["callbacks"] = { onReady: vi.fn() },
  playback = new ReplayPremierePlaybackController(PREMIERE_ID),
) {
  return {
    playback,
    network: new ReplayPremiereNetworkController({
      premiereId: PREMIERE_ID,
      playback,
      callbacks,
      fetchImpl,
      pollIntervalMs: 1,
      initialRetryMs: 1,
      maxRetryMs: 5,
    }),
  };
}

async function expectNetworkError(
  promise: Promise<unknown>,
  code: ReplayPremiereNetworkError["code"],
) {
  try {
    await promise;
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayPremiereNetworkError);
    expect((error as ReplayPremiereNetworkError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

async function revealMaterial(
  options: {
    leakEvidenceBodyBytes?: number;
    leakEvidenceBodyBytesByCheckId?: Readonly<Record<string, number>>;
  } = {},
) {
  return releasedRevealMaterial(
    await verifiedPublicationFixture(fixtureRoot, options),
  );
}

function releasedRevealMaterial(
  publication: Pick<
    Awaited<ReturnType<typeof verifiedPublicationFixture>>,
    "gate" | "drafts"
  >,
) {
  const { gate, drafts } = publication;
  const wireBootstrap = createPremierePublicBootstrap({ gate });
  const released: ReleasedPremiereChunk[] = [];
  let terminalGate: ReturnType<typeof gate.prepareTerminalChunk> | null = null;
  for (const [index, draft] of drafts.entries()) {
    const releasedAt = new Date(
      Date.parse("2026-07-20T18:00:01.000Z") + index * 1_000,
    ).toISOString();
    const previousChunk = released.at(-1) ?? null;
    if (draft.descriptor.terminal) {
      terminalGate = gate.prepareTerminalChunk({
        draft,
        releasedAt,
        previousChunk,
        authoritativeElapsedMs: draft.descriptor.presentationOffsetMs,
      });
      released.push(terminalGate.chunk());
    } else {
      released.push(
        gate.releaseNonTerminalChunk({
          draft,
          releasedAt,
          previousChunk,
          authoritativeElapsedMs: draft.descriptor.presentationOffsetMs,
        }),
      );
    }
  }
  if (!terminalGate) throw new Error("missing server terminal fixture");
  const chunks = released.map((chunk) =>
    toPremierePublicChunkResponse(chunk, gate),
  ) as PublicChunk[];
  const reveal = createPremiereRevealResponse({
    gate,
    terminal: terminalGate,
  });
  const pointer = createPremiereRevealPointer(reveal);
  return {
    bootstrap: wireBootstrap,
    recordHash: gate.eligibilityRecordHash,
    nonTerminal: chunks.slice(0, -1),
    first: chunks[0],
    terminal: chunks.at(-1)!,
    chunks,
    reveal,
    pointer,
  };
}

async function longRevealMaterial() {
  return releasedRevealMaterial(
    await verifiedLongPublicationFixture(fixtureRoot),
  );
}

async function resealReveal(
  inputReveal: ReplayPremiereRevealWire,
  inputPointer: ReturnType<typeof createPremiereRevealPointer>,
) {
  const reveal = structuredClone(inputReveal);
  const pointer = structuredClone(inputPointer);
  reveal.revealCommitHash = await hashCanonicalJson({
    schemaVersion: 1,
    premiereId: reveal.premiereId,
    eligibilityRecordHash: reveal.eligibilityRecordHash,
    publicationCommitmentHash: reveal.publicationCommitmentHash,
    publicationCommitment: reveal.publicationCommitment,
    sourceReplaySha256: reveal.sourceReplaySha256,
    resultHash: reveal.resultHash,
    authoritativeResult: reveal.authoritativeResult,
    publicationDraftManifest: reveal.publicationDraftManifest,
    finalSequence: reveal.finalSequence,
    finalChunkIndex: reveal.finalChunkIndex,
    finalChunkHash: reveal.finalChunkHash,
    revealedAt: reveal.revealedAt,
  });
  pointer.revealCommitHash = reveal.revealCommitHash;
  return { reveal, pointer };
}

async function resealChunkReleasedAt(
  input: PublicChunk,
  releasedAt: string,
): Promise<PublicChunk> {
  const chunk = structuredClone(input);
  chunk.releasedAt = releasedAt;
  const { chunkHash: _chunkHash, ...hashInput } = descriptor(chunk);
  chunk.chunkHash = await hashCanonicalJson(hashInput);
  return chunk;
}

async function withCanonicalResultMutation(
  input: ReplayPremiereRevealWire,
  mutate: (result: Record<string, unknown>) => void,
): Promise<ReplayPremiereRevealWire> {
  const reveal = structuredClone(input);
  const result = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(reveal.authoritativeResult.bytes), (character) =>
        character.charCodeAt(0),
      ),
    ),
  ) as Record<string, unknown>;
  mutate(result);
  const bytes = canonicalJsonBytes(result);
  const resultHash = await sha256Hex(bytes);
  reveal.authoritativeResult.bytes = btoa(String.fromCharCode(...bytes));
  reveal.authoritativeResult.sha256 = resultHash;
  reveal.resultHash = resultHash;
  reveal.eligibilityRecord.authoritativeResult.resultHash = resultHash;
  return reveal;
}

describe("ReplayPremiereNetwork", () => {
  it("uses the same canonical UTF-8 representation independent of key order", async () => {
    expect(canonicalReplayPremiereJson({ z: -0, a: [true, "é"] })).toBe(
      '{"a":[true,"é"],"z":0}',
    );
    await expect(hashCanonicalJson({ b: 2, a: 1 })).resolves.toBe(
      await hashCanonicalJson({ a: 1, b: 2 }),
    );
  });

  it("loads bootstrap first, verifies only advertised chunks, and never fetches an ordinary replay artifact", async () => {
    const chunk = await buildChunk({
      index: 0,
      records: records(0, 1),
      previousChunkHash: null,
    });
    const readyStates: Array<number | null> = [];
    const readyDefinitions: unknown[] = [];
    const wireBootstrap = await bootstrap();
    const fetchMock = queuedFetch(
      jsonResponse(wireBootstrap),
      jsonResponse(await manifest([chunk])),
      jsonResponse(chunk),
    );
    const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
    const { network } = controller(
      fetchMock as unknown as typeof fetch,
      {
        onReady: (projection) => {
          readyStates.push(playback.state().releasedThroughSequence);
          readyDefinitions.push(projection.publicDefinition);
        },
      },
      playback,
    );

    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "active",
    });
    expect(readyStates).toEqual([null]);
    expect(readyDefinitions).toEqual([wireBootstrap.publicDefinition]);
    expect(playback.state()).toMatchObject({
      nextChunkIndex: 1,
      releasedThroughSequence: 1,
      lastChunkHash: chunk.chunkHash,
    });
    const paths = fetchMock.mock.calls.map(([path]) => String(path));
    expect(paths).toEqual([
      `/api/premieres/${PREMIERE_ID}/bootstrap`,
      `/api/premieres/${PREMIERE_ID}/manifest`,
      `/api/premieres/${PREMIERE_ID}/chunks/0`,
    ]);
    expect(paths.every((path) => path.startsWith("/api/premieres/"))).toBe(
      true,
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
    }
  });

  it("rejects a bootstrap hash mismatch and never calls onReady", async () => {
    const ready = vi.fn();
    const invalid = { ...(await bootstrap()), gameStartInfoHash: ONE_HASH };
    const { network } = controller(
      queuedFetch(jsonResponse(invalid)) as unknown as typeof fetch,
      { onReady: ready },
    );
    await expectNetworkError(network.syncOnce(), "bootstrap_integrity_failure");
    expect(ready).not.toHaveBeenCalled();
  });

  it("rejects any full publication preimage leaked through bootstrap", async () => {
    const leaked = {
      ...(await bootstrap()),
      publicationCommitment: { finalSequence: 5, chunkCount: 3 },
    };
    const { network } = controller(
      queuedFetch(jsonResponse(leaked)) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "invalid_schema");
  });

  it("rejects pre-reveal outcome and future fields before any manifest callback", async () => {
    const onManifest = vi.fn();
    const leaked = {
      ...(await manifest()),
      finalSequence: 99,
      winner: "seat_0",
    };
    const { network } = controller(
      queuedFetch(
        jsonResponse(await bootstrap()),
        jsonResponse(leaked),
      ) as unknown as typeof fetch,
      { onReady: vi.fn(), onManifest },
    );
    await expectNetworkError(network.syncOnce(), "outcome_field_leak");
    expect(onManifest).not.toHaveBeenCalled();
  });

  it("rejects missing no-store and non-JSON response policy", async () => {
    const { network } = controller(
      queuedFetch(
        jsonResponse(await bootstrap(), { noStore: false }),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "invalid_cache_policy");

    const second = controller(
      queuedFetch(
        jsonResponse(await bootstrap(), { contentType: "text/plain" }),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(second.network.syncOnce(), "invalid_content_type");
  });

  it("stops reading a chunked response as soon as the byte limit is exceeded", async () => {
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode('{"padding":"'));
        stream.enqueue(encoder.encode("x".repeat(64)));
        stream.enqueue(encoder.encode('"}'));
      },
      cancel: cancelled,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        }),
    );
    const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
    const network = new ReplayPremiereNetworkController({
      premiereId: PREMIERE_ID,
      playback,
      callbacks: { onReady: vi.fn() },
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxResponseBytes: 32,
    });

    await expectNetworkError(network.syncOnce(), "response_too_large");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("times out an in-flight request with a sanitized recoverable error", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
    const network = new ReplayPremiereNetworkController({
      premiereId: PREMIERE_ID,
      playback,
      callbacks: { onReady: vi.fn() },
      fetchImpl: fetchMock as unknown as typeof fetch,
      requestTimeoutMs: 10,
    });

    try {
      await network.syncOnce();
      throw new Error("expected request to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayPremiereNetworkError);
      expect((error as ReplayPremiereNetworkError).code).toBe("request_failed");
      expect((error as ReplayPremiereNetworkError).recoverable).toBe(true);
      expect((error as Error).message).toBe("request_failed");
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  });

  it("rejects payload tampering even when the envelope matches the advertised descriptor", async () => {
    const chunk = await buildChunk({
      index: 0,
      records: records(0, 1),
      previousChunkHash: null,
    });
    const tampered = structuredClone(chunk);
    tampered.records[1].payload.hash = 42;
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(await bootstrap()),
        jsonResponse(await manifest([chunk])),
        jsonResponse(tampered),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "chunk_integrity_failure");
    expect(playback.state().releasedThroughSequence).toBeNull();
  });

  it("binds releasedAt into the published chunk hash", async () => {
    const chunk = await buildChunk({
      index: 0,
      records: records(0, 1),
      previousChunkHash: null,
    });
    const tampered = {
      ...chunk,
      releasedAt: "2026-07-20T18:00:13.000Z",
    };
    const { network } = controller(
      queuedFetch(
        jsonResponse(await bootstrap()),
        jsonResponse(await manifest([tampered])),
        jsonResponse(tampered),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "chunk_integrity_failure");
  });

  it("rejects any chunk whose source, run, policy, or eligibility provenance drifts", async () => {
    const chunk = await buildChunk({
      index: 0,
      records: records(0, 1),
      previousChunkHash: null,
    });
    const tampered = {
      ...chunk,
      provenance: {
        ...chunk.provenance,
        sourceRunId: "run_other",
      },
    };
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(await bootstrap()),
        jsonResponse(await manifest([chunk])),
        jsonResponse(tampered),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "manifest_integrity_failure");
    expect(playback.state().releasedThroughSequence).toBeNull();
  });

  it("rejects sparse, duplicate, and decreasing turn sequences", async () => {
    for (const turnNumbers of [
      [0, 2],
      [0, 0],
      [1, 0],
    ]) {
      const chunk = await buildChunk({
        index: 0,
        records: records(...turnNumbers),
        previousChunkHash: null,
      });
      const { network } = controller(
        queuedFetch(
          jsonResponse(await bootstrap()),
          jsonResponse(await manifest([chunk])),
          jsonResponse(chunk),
        ) as unknown as typeof fetch,
      );
      await expectNetworkError(
        network.syncOnce(),
        "manifest_integrity_failure",
      );
    }
  });

  it("rejects a regressing manifest without refetching accepted chunks", async () => {
    const first = await manifest([], { authoritativeElapsedMs: 500 });
    const second = await manifest([], {
      serverNow: "2026-07-20T18:00:21.000Z",
      authoritativeElapsedMs: 499,
    });
    const fetchMock = queuedFetch(
      jsonResponse(await bootstrap()),
      jsonResponse(first),
      jsonResponse(second),
    );
    const { network } = controller(fetchMock as unknown as typeof fetch);
    await network.syncOnce();
    await expectNetworkError(network.syncOnce(), "manifest_regression");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("requests forward-only catch-up when the accepted replay is over two seconds behind", async () => {
    const chunk = await buildChunk({
      index: 0,
      records: records(0, 1),
      previousChunkHash: null,
    });
    const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
    const eventTypes: string[] = [];
    playback.subscribe((event) => eventTypes.push(event.type));
    const { network } = controller(
      queuedFetch(
        jsonResponse(await bootstrap()),
        jsonResponse(
          await manifest([chunk], { authoritativeElapsedMs: 5_000 }),
        ),
        jsonResponse(chunk),
      ) as unknown as typeof fetch,
      { onReady: vi.fn() },
      playback,
    );
    await network.syncOnce();
    expect(eventTypes).toEqual(["batch", "catch-up"]);
  });

  it("retries a reconnectable request with a bounded sanitized notice", async () => {
    const cancelled = await manifest([], {
      state: "cancelled",
      actualStartAt: null,
      authoritativeElapsedMs: 0,
    });
    const recovering = vi.fn();
    const fetchMock = queuedFetch(
      new TypeError("private network detail"),
      jsonResponse(await bootstrap()),
      jsonResponse(cancelled),
    );
    const { network } = controller(fetchMock as unknown as typeof fetch, {
      onReady: vi.fn(),
      onRecovering: recovering,
    });
    await expect(network.start()).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(recovering).toHaveBeenCalledWith({
      code: "request_failed",
      attempt: 1,
      retryInMs: 1,
    });
    expect(JSON.stringify(recovering.mock.calls)).not.toContain(
      "private network detail",
    );
    expect(
      () =>
        new ReplayPremiereNetworkController({
          premiereId: PREMIERE_ID,
          playback: new ReplayPremierePlaybackController(PREMIERE_ID),
          callbacks: { onReady: vi.fn() },
          fetchImpl: fetchMock as unknown as typeof fetch,
          maxRetryMs: 5_001,
        }),
    ).toThrowError(ReplayPremiereNetworkError);
  });

  it("aborts an in-flight request on dispose", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const { network } = controller(fetchMock as unknown as typeof fetch);
    const pending = network.syncOnce();
    network.dispose();
    await expectNetworkError(pending, "disposed");
  });

  it("verifies the nonce-bound eligibility, reveal commitment, and terminal release chain before finalization", async () => {
    const material = await revealMaterial();
    const preManifest = await manifest(material.nonTerminal, {
      provenance: material.bootstrap.provenance,
      scheduledAt: material.bootstrap.publicDefinition.scheduledAt,
      playbackRate: material.bootstrap.publicDefinition.playbackRate,
      serverNow: material.pointer.revealedAt,
      actualStartAt: material.bootstrap.publicDefinition.scheduledAt,
      authoritativeElapsedMs: 250,
    });
    const onReveal = vi.fn();
    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(preManifest),
      ...material.nonTerminal.map((chunk) => jsonResponse(chunk)),
      jsonResponse(material.pointer),
      jsonResponse(material.reveal),
      jsonResponse(material.terminal),
    );
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
      { onReady: vi.fn(), onReveal },
    );
    await network.syncOnce();
    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "revealed",
    });
    expect(playback.state()).toMatchObject({
      nextChunkIndex: material.chunks.length,
      releasedThroughSequence: material.reveal.finalSequence,
      lastChunkHash: material.terminal.chunkHash,
      finalized: true,
    });
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("accepts a reveal observed after a stale playing response whose server clock is later than revealedAt", async () => {
    const material = await revealMaterial();
    const preManifest = await manifest(material.nonTerminal, {
      provenance: material.bootstrap.provenance,
      scheduledAt: material.bootstrap.publicDefinition.scheduledAt,
      playbackRate: material.bootstrap.publicDefinition.playbackRate,
      serverNow: new Date(
        Date.parse(material.pointer.revealedAt) + 77,
      ).toISOString(),
      actualStartAt: material.bootstrap.publicDefinition.scheduledAt,
      authoritativeElapsedMs: 250,
    });
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(preManifest),
        ...material.nonTerminal.map((chunk) => jsonResponse(chunk)),
        jsonResponse(material.pointer),
        jsonResponse(material.reveal),
        jsonResponse(material.terminal),
      ) as unknown as typeof fetch,
    );

    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "active",
    });
    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "revealed",
    });
    expect(playback.state()).toMatchObject({
      finalized: true,
      releasedThroughSequence: material.reveal.finalSequence,
    });
  });

  it("rejects a reveal timestamp earlier than an authenticated prefix chunk release", async () => {
    const material = await revealMaterial();
    const futurePrefix = await resealChunkReleasedAt(
      material.nonTerminal[0],
      new Date(Date.parse(material.pointer.revealedAt) + 1).toISOString(),
    );
    const preManifest = await manifest([futurePrefix], {
      provenance: material.bootstrap.provenance,
      scheduledAt: material.bootstrap.publicDefinition.scheduledAt,
      playbackRate: material.bootstrap.publicDefinition.playbackRate,
      serverNow: new Date(
        Date.parse(material.pointer.revealedAt) + 77,
      ).toISOString(),
      actualStartAt: material.bootstrap.publicDefinition.scheduledAt,
      authoritativeElapsedMs: 250,
    });
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(preManifest),
        jsonResponse(futurePrefix),
        jsonResponse(material.pointer),
        jsonResponse(material.reveal),
      ) as unknown as typeof fetch,
    );

    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "active",
    });
    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });

  it("rejects a coherently resealed terminal chunk whose release time differs from revealedAt", async () => {
    const material = await revealMaterial();
    const terminal = await resealChunkReleasedAt(
      material.terminal,
      new Date(Date.parse(material.pointer.revealedAt) + 1).toISOString(),
    );
    const reveal = structuredClone(material.reveal) as ReplayPremiereRevealWire;
    reveal.finalChunkHash = terminal.chunkHash;
    const sealed = await resealReveal(reveal, material.pointer);
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(sealed.pointer),
        jsonResponse(sealed.reveal),
        ...material.nonTerminal.map((chunk) => jsonResponse(chunk)),
        jsonResponse(terminal),
      ) as unknown as typeof fetch,
    );

    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });

  it("recovers an advertised but unaccepted chunk when reveal follows a transport interruption", async () => {
    const material = await revealMaterial();
    const preManifest = await manifest(material.nonTerminal, {
      provenance: material.bootstrap.provenance,
      scheduledAt: material.bootstrap.publicDefinition.scheduledAt,
      playbackRate: material.bootstrap.publicDefinition.playbackRate,
      serverNow: material.pointer.revealedAt,
      actualStartAt: material.bootstrap.publicDefinition.scheduledAt,
      authoritativeElapsedMs: 250,
    });
    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(preManifest),
      jsonResponse(material.nonTerminal[0]),
      new TypeError("transient chunk transport failure"),
      jsonResponse(material.pointer),
      jsonResponse(material.reveal),
      jsonResponse(material.nonTerminal[1]),
      jsonResponse(material.terminal),
    );
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
    );

    await expect(network.syncOnce()).rejects.toMatchObject({
      code: "request_failed",
      recoverable: true,
    });
    expect(playback.state()).toMatchObject({
      nextChunkIndex: 1,
      releasedThroughSequence: material.nonTerminal[0].endSequence,
      finalized: false,
    });

    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "revealed",
    });
    expect(playback.state()).toMatchObject({
      nextChunkIndex: material.chunks.length,
      releasedThroughSequence: material.reveal.finalSequence,
      lastChunkHash: material.terminal.chunkHash,
      finalized: true,
    });
  });

  it("rejects a revealed suffix that changes an earlier advertised descriptor", async () => {
    const material = await revealMaterial();
    const preManifest = await manifest(material.nonTerminal, {
      provenance: material.bootstrap.provenance,
      scheduledAt: material.bootstrap.publicDefinition.scheduledAt,
      playbackRate: material.bootstrap.publicDefinition.playbackRate,
      serverNow: material.pointer.revealedAt,
      actualStartAt: material.bootstrap.publicDefinition.scheduledAt,
      authoritativeElapsedMs: 250,
    });
    preManifest.releasedChunks[1].releasedAt = SERVER_NOW;
    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(preManifest),
      jsonResponse(material.nonTerminal[0]),
      new TypeError("transient chunk transport failure"),
      jsonResponse(material.pointer),
      jsonResponse(material.reveal),
      jsonResponse(material.nonTerminal[1]),
    );
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
    );

    await expect(network.syncOnce()).rejects.toMatchObject({
      code: "request_failed",
      recoverable: true,
    });
    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state()).toMatchObject({
      nextChunkIndex: 1,
      finalized: false,
    });
  });

  it("accepts the exact large committed leak-evidence bodies seen by a live reveal", async () => {
    const expectedSizes = {
      "league-page": 61_137,
      "league-data": 40_660,
      "battle-card-data": 40_660,
    } as const;
    const material = await revealMaterial({
      leakEvidenceBodyBytesByCheckId: expectedSizes,
    });
    for (const [checkId, expectedBytes] of Object.entries(expectedSizes)) {
      const observedBodyText =
        material.reveal.eligibilityRecord.proxyWarLeakChecks.find(
          (evidence) => evidence.checkId === checkId,
        )?.observedBodyText;
      expect(observedBodyText).not.toBeNull();
      expect(new TextEncoder().encode(observedBodyText!).byteLength).toBe(
        expectedBytes,
      );
    }

    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(material.pointer),
      jsonResponse(material.reveal),
      ...material.chunks.map((chunk) => jsonResponse(chunk)),
    );
    const onReveal = vi.fn();
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
      { onReady: vi.fn(), onReveal },
    );

    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "revealed",
    });
    expect(playback.state()).toMatchObject({
      nextChunkIndex: material.chunks.length,
      releasedThroughSequence: material.reveal.finalSequence,
      finalized: true,
    });
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("retries a transient reveal fetch without weakening final integrity checks", async () => {
    const material = await revealMaterial({
      leakEvidenceBodyBytesByCheckId: {
        "league-page": 61_137,
        "league-data": 40_660,
        "battle-card-data": 40_660,
      },
    });
    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(material.pointer),
      new TypeError("transient reveal transport failure"),
      jsonResponse(material.pointer),
      jsonResponse(material.reveal),
      ...material.chunks.map((chunk) => jsonResponse(chunk)),
    );
    const onReveal = vi.fn();
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
      { onReady: vi.fn(), onReveal },
    );

    await expect(network.syncOnce()).rejects.toMatchObject({
      code: "request_failed",
      recoverable: true,
    });
    expect(playback.state().finalized).toBe(false);

    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "revealed",
    });
    expect(playback.state()).toMatchObject({
      releasedThroughSequence: material.reveal.finalSequence,
      finalized: true,
    });
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("prefetches a revealed suffix concurrently but accepts it in chain order", async () => {
    const material = await revealMaterial();
    const pendingChunks = new Map<number, (response: Response) => void>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const pathname = String(input);
      if (pathname.endsWith("/bootstrap")) {
        return Promise.resolve(jsonResponse(material.bootstrap));
      }
      if (pathname.endsWith("/manifest")) {
        return Promise.resolve(jsonResponse(material.pointer));
      }
      if (pathname.endsWith("/reveal")) {
        return Promise.resolve(jsonResponse(material.reveal));
      }
      const chunkIndex = Number(pathname.match(/\/chunks\/(\d+)$/)?.[1]);
      if (!Number.isSafeInteger(chunkIndex)) {
        return Promise.reject(new Error("unexpected request"));
      }
      return new Promise<Response>((resolve) => {
        pendingChunks.set(chunkIndex, resolve);
      });
    });
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
    );

    const syncing = network.syncOnce();
    await vi.waitFor(() => {
      expect(pendingChunks.size).toBe(material.chunks.length);
    });
    expect(pendingChunks.size).toBeLessThanOrEqual(
      REPLAY_PREMIERE_REVEAL_FETCH_CONCURRENCY,
    );
    for (let index = material.chunks.length - 1; index >= 0; index -= 1) {
      pendingChunks.get(index)!(jsonResponse(material.chunks[index]));
    }

    await expect(syncing).resolves.toMatchObject({ status: "revealed" });
    expect(playback.state()).toMatchObject({
      nextChunkIndex: material.chunks.length,
      releasedThroughSequence: material.reveal.finalSequence,
      finalized: true,
    });
  });

  it("verifies the production 120-chunk recovery envelope with bounded parallel fetches in under five seconds", async () => {
    const material = await longRevealMaterial();
    expect(material.chunks).toHaveLength(120);
    let activeChunkFetches = 0;
    let maximumActiveChunkFetches = 0;
    let revealFetches = 0;
    let abortedSiblingFetches = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = String(input);
        if (pathname.endsWith("/bootstrap")) {
          return jsonResponse(material.bootstrap);
        }
        if (pathname.endsWith("/manifest")) {
          return jsonResponse(material.pointer);
        }
        if (pathname.endsWith("/reveal")) {
          revealFetches += 1;
          return jsonResponse(material.reveal);
        }
        const chunkIndex = Number(pathname.match(/\/chunks\/(\d+)$/)?.[1]);
        if (!Number.isSafeInteger(chunkIndex)) {
          throw new Error("unexpected request");
        }
        activeChunkFetches += 1;
        maximumActiveChunkFetches = Math.max(
          maximumActiveChunkFetches,
          activeChunkFetches,
        );
        if (revealFetches === 1) {
          if (chunkIndex === 0) {
            await Promise.resolve();
            activeChunkFetches -= 1;
            throw new TypeError("first reveal chunk failed");
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                activeChunkFetches -= 1;
                abortedSiblingFetches += 1;
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeChunkFetches -= 1;
        return jsonResponse(material.chunks[chunkIndex]);
      },
    );
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
    );

    await expect(network.syncOnce()).rejects.toMatchObject({
      code: "request_failed",
      recoverable: true,
    });
    expect(activeChunkFetches).toBe(0);
    expect(abortedSiblingFetches).toBe(
      REPLAY_PREMIERE_REVEAL_FETCH_CONCURRENCY - 1,
    );
    expect(playback.state()).toMatchObject({
      nextChunkIndex: 0,
      finalized: false,
    });

    const startedAt = performance.now();
    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "revealed",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(maximumActiveChunkFetches).toBe(
      REPLAY_PREMIERE_REVEAL_FETCH_CONCURRENCY,
    );
    expect(maximumActiveChunkFetches).toBeLessThanOrEqual(
      REPLAY_PREMIERE_REVEAL_FETCH_CONCURRENCY,
    );
    expect(playback.state()).toMatchObject({
      nextChunkIndex: 120,
      releasedThroughSequence: material.reveal.finalSequence,
      finalized: true,
    });
    expect(elapsedMs).toBeLessThan(5_000);
  }, 20_000);

  it("anchors an archived visitor through bootstrap provenance and emits archived terminal state", async () => {
    const material = await revealMaterial();
    const archivedPointer = {
      ...material.pointer,
      state: "archived" as const,
    };
    const onReady = vi.fn();
    const onTerminal = vi.fn();
    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(archivedPointer),
      jsonResponse(material.reveal),
      ...material.chunks.map((chunk) => jsonResponse(chunk)),
    );
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
      { onReady, onTerminal },
    );
    await expect(network.syncOnce()).resolves.toMatchObject({
      status: "archived",
    });
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "archived",
        playbackRate: material.bootstrap.publicDefinition.playbackRate,
        publicDefinition: material.bootstrap.publicDefinition,
        provenance: material.bootstrap.provenance,
      }),
    );
    expect(playback.state()).toMatchObject({
      nextChunkIndex: material.chunks.length,
      finalized: true,
      lastChunkHash: material.terminal.chunkHash,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3 + material.chunks.length);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith("archived");
  });

  it("does not finalize an archived pointer whose reveal binding is invalid", async () => {
    const material = await revealMaterial();
    const archivedPointer = {
      ...material.pointer,
      state: "archived" as const,
      revealCommitHash: "7".repeat(64),
    };
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(archivedPointer),
        jsonResponse(material.reveal),
      ) as unknown as typeof fetch,
    );

    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });

  it("rejects a resealed reveal whose full publication commitment was tampered", async () => {
    const material = await revealMaterial();
    const tampered = structuredClone(
      material.reveal,
    ) as ReplayPremiereRevealWire;
    tampered.publicationCommitment.maxPresentationSpanMs = 999;
    const sealed = await resealReveal(tampered, material.pointer);
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(sealed.pointer),
        jsonResponse(sealed.reveal),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });

  it("rejects a resealed reveal whose draft root or prepublication chain was tampered", async () => {
    const material = await revealMaterial();
    const tampered = structuredClone(
      material.reveal,
    ) as ReplayPremiereRevealWire;
    tampered.publicationDraftManifest[0].prepublicationHash = "7".repeat(64);
    const sealed = await resealReveal(tampered, material.pointer);
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(sealed.pointer),
        jsonResponse(sealed.reveal),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });

  it("rejects a pointer whose publication provenance drifts from bootstrap", async () => {
    const material = await revealMaterial();
    const pointer = structuredClone(material.pointer);
    pointer.provenance.publicationCommitmentHash = "7".repeat(64);
    const { network, playback } = controller(
      queuedFetch(
        jsonResponse(material.bootstrap),
        jsonResponse(pointer),
      ) as unknown as typeof fetch,
    );
    await expectNetworkError(network.syncOnce(), "manifest_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });

  it("binds canonical result source identity and winner-or-void semantics", async () => {
    const material = await revealMaterial();
    const sourceDrift = await withCanonicalResultMutation(
      material.reveal as ReplayPremiereRevealWire,
      (result) => {
        result.sourceId = "controlled-run-001:other-result";
      },
    );
    await expectNetworkError(
      verifyReplayPremiereAuthoritativeResult(sourceDrift, material.bootstrap),
      "reveal_integrity_failure",
    );

    for (const winner of [["player", "SEAT0002"], null] as const) {
      const winnerDrift = await withCanonicalResultMutation(
        material.reveal as ReplayPremiereRevealWire,
        (result) => {
          result.winner = winner;
        },
      );
      await expectNetworkError(
        verifyReplayPremiereAuthoritativeResult(
          winnerDrift,
          material.bootstrap,
        ),
        "reveal_integrity_failure",
      );
    }
  });

  it("requires the authoritative result's exact server key set", async () => {
    const material = await revealMaterial();
    const extraKey = await withCanonicalResultMutation(
      material.reveal as ReplayPremiereRevealWire,
      (result) => {
        result.unexpected = "not-in-the-wire-contract";
      },
    );
    await expectNetworkError(
      verifyReplayPremiereAuthoritativeResult(extraKey, material.bootstrap),
      "reveal_integrity_failure",
    );
  });

  it("does not treat a tampered authoritative result envelope as verified", async () => {
    const material = await revealMaterial();
    const tamperedReveal = structuredClone(material.reveal);
    tamperedReveal.authoritativeResult.bytes = btoa("{}");
    const preManifest = await manifest(material.nonTerminal, {
      provenance: material.bootstrap.provenance,
      scheduledAt: material.bootstrap.publicDefinition.scheduledAt,
      playbackRate: material.bootstrap.publicDefinition.playbackRate,
      serverNow: material.pointer.revealedAt,
      actualStartAt: material.bootstrap.publicDefinition.scheduledAt,
      authoritativeElapsedMs: 250,
    });
    const fetchMock = queuedFetch(
      jsonResponse(material.bootstrap),
      jsonResponse(preManifest),
      ...material.nonTerminal.map((chunk) => jsonResponse(chunk)),
      jsonResponse(material.pointer),
      jsonResponse(tamperedReveal),
    );
    const { network, playback } = controller(
      fetchMock as unknown as typeof fetch,
    );
    await network.syncOnce();
    await expectNetworkError(network.syncOnce(), "reveal_integrity_failure");
    expect(playback.state().finalized).toBe(false);
  });
});
