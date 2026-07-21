import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createReplayPremiereTrustedProxyAddressResolver,
  REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
  type ReplayPremiereClientAddressResolver,
} from "../../../src/server/replay-premiere/ReplayPremiereClientAddress";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import type {
  ReplayPremiereSnapshot,
  StoredReplayPremiereEvent,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  formatReplayPremiereHttpOperatorError,
  ReplayPremiereHttpRegistry,
  type ReplayPremiereHttpTarget,
} from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  REPLAY_PREMIERE_REACTION_KINDS,
  ReplayPremiereInteractions,
} from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import {
  ReplayPremiereAtomicPublication,
  type PremiereRevealPersistence,
} from "../../../src/server/replay-premiere/ReplayPremiereRevealCommit";
import {
  createDraftPremiereLifecycle,
  recordSafeReleasedSequence,
  transitionPremiereLifecycle,
} from "../../../src/server/replay-premiere/ReplayPremiereStateMachine";
import {
  createPremierePublicBootstrap,
  createPremierePublicProvenance,
  toPremierePublicChunkResponse,
  type PremierePreRevealManifestResponse,
} from "../../../src/server/replay-premiere/ReplayPremiereWire";
import {
  NOW,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

const EXPECTED_ORIGIN = "https://beta.proxywar.xyz";

describe("ReplayPremiere HTTP adapter", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-http-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("formats only bounded scalar operator diagnostics", () => {
    const rejection = Object.assign(
      new ReplayPremiereError(
        "invalid_observedSequence",
        "PREMIERE_INVALID_REQUEST",
        400,
        "private body, cookie, address, and path details",
      ),
      {
        requestBody: "secret body",
        cookie: "secret cookie",
        remoteAddress: "secret address",
      },
    );
    expect(formatReplayPremiereHttpOperatorError(rejection)).toBe(
      "Replay Premiere HTTP rejected operatorCode=invalid_observedSequence status=400 publicCode=PREMIERE_INVALID_REQUEST",
    );

    const unsafe = new ReplayPremiereError(
      "token=/private/path",
      "PREMIERE_INVALID_REQUEST",
      400,
      "secret exception text",
    );
    const rendered = formatReplayPremiereHttpOperatorError(unsafe);
    expect(rendered).toBe(
      "Replay Premiere HTTP rejected operatorCode=unexpected_failure status=400 publicCode=PREMIERE_INVALID_REQUEST",
    );
    expect(rendered).not.toContain("token");
    expect(rendered).not.toContain("private");
    expect(rendered).not.toContain("secret");
  });

  test("serves authentic Wire bootstrap, manifest, chunk, and reveal with no-store", async () => {
    const harness = await httpHarness(root, true);
    await harness.run(async (baseUrl) => {
      for (const suffix of ["bootstrap", "manifest", "chunks/0", "reveal"]) {
        const response = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/${suffix}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("cdn-cache-control")).toBe("no-store");
        expect(response.headers.get("surrogate-control")).toBe("no-store");
        expect(response.headers.get("pragma")).toBe("no-cache");
        expect(response.headers.get("etag")).toBeNull();
        const body = await response.json();
        expect(body).toMatchObject({
          schemaVersion: 1,
          premiereId: PREMIERE_ID,
        });
      }
      const manifest = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
      ).then((response) => response.json());
      expect(manifest).toMatchObject({ state: "revealed" });
      const reveal = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/reveal`,
      ).then((response) => response.json());
      expect(reveal).toMatchObject({
        state: "revealed",
        finalSequence: 5,
        authoritativeResult: { encoding: "canonical_json_utf8_base64" },
      });
    });
  });

  test("returns sanitized 404 before terminal release and rejects Range, methods, and admin paths", async () => {
    const harness = await httpHarness(root, false);
    await harness.run(async (baseUrl) => {
      for (const suffix of ["chunks/2", "reveal"]) {
        const response = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/${suffix}`,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_UNAVAILABLE" },
        });
      }
      const ranged = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/chunks/0`,
        { headers: { Range: "bytes=0-10" } },
      );
      expect(ranged.status).toBe(416);
      expect(await ranged.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
      const wrongMethod = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");
      for (const contentType of [undefined, "text/plain"] as const) {
        const headers =
          contentType === undefined
            ? undefined
            : { "Content-Type": contentType };
        const readOnlyPost = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/bootstrap`,
          { method: "POST", headers, body: "{}" },
        );
        expect(readOnlyPost.status).toBe(405);
        expect(readOnlyPost.headers.get("allow")).toBe("GET, HEAD");

        const absentWrite = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/publish`,
          { method: "POST", headers, body: "{}" },
        );
        expect(absentWrite.status).toBe(404);

        const realWrite = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`,
          { method: "POST", headers, body: "{}" },
        );
        expect(realWrite.status).toBe(415);
      }
      for (const suffix of ["publish", "source", "transition", "admin"]) {
        const response = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/${suffix}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        expect(response.status).toBe(404);
      }
    });
  });

  test("bootstraps reload-safe CSRF and requires cookie, Origin, and token on every later write", async () => {
    const harness = await httpHarness(root, true);
    await harness.run(async (baseUrl) => {
      const sessionUrl = `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`;
      const sessionResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders("session_request_00000001"),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(harness.operatorErrors).toEqual([]);
      expect(sessionResponse.status).toBe(201);
      const cookie = sessionResponse.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      const sessionBody = await sessionResponse.json();
      expect(sessionBody).toMatchObject({
        schemaVersion: 1,
        csrfToken: expect.any(String),
        incomingMoment: null,
        premiereState: "revealed",
        session: { premiereId: PREMIERE_ID },
      });
      expect(harness.admissions[0]).toMatchObject({
        route: "session",
        requesterBucketId:
          harness.security.deriveRequesterBucketId("127.0.0.1"),
      });

      const heartbeatUrl = `${sessionUrl}/${sessionBody.session.id}/heartbeat`;
      const withoutCsrf = await fetch(heartbeatUrl, {
        method: "POST",
        headers: writeHeaders("heartbeat_request_000001", cookie ?? undefined),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(withoutCsrf.status).toBe(403);
      expect(await withoutCsrf.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
      const heartbeat = await fetch(heartbeatUrl, {
        method: "POST",
        headers: writeHeaders(
          "heartbeat_request_000002",
          cookie ?? undefined,
          sessionBody.csrfToken,
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toMatchObject({
        schemaVersion: 1,
        persisted: false,
      });

      for (const [index, kind] of REPLAY_PREMIERE_REACTION_KINDS.entries()) {
        const reaction = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/reactions`,
          {
            method: "POST",
            headers: writeHeaders(
              `reaction_request_${index.toString().padStart(16, "0")}`,
              cookie ?? undefined,
              sessionBody.csrfToken,
            ),
            body: JSON.stringify({
              sessionId: sessionBody.session.id,
              sequence: index,
              kind,
            }),
          },
        );
        expect(reaction.status).toBe(200);
        expect(await reaction.json()).toMatchObject({
          schemaVersion: 1,
          reaction: { kind },
        });
      }
      const unknownReaction = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/reactions`,
        {
          method: "POST",
          headers: writeHeaders(
            "reaction_unknown_000001",
            cookie ?? undefined,
            sessionBody.csrfToken,
          ),
          body: JSON.stringify({
            sessionId: sessionBody.session.id,
            sequence: 5,
            kind: "funny",
          }),
        },
      );
      expect(unknownReaction.status).toBe(400);

      const reload = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders("session_request_00000002", cookie ?? undefined),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(reload.status).toBe(201);
      expect((await reload.json()).csrfToken).toEqual(expect.any(String));

      const wrongOrigin = await fetch(sessionUrl, {
        method: "POST",
        headers: {
          ...writeHeaders("session_request_00000003"),
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(wrongOrigin.status).toBe(403);
    });
  });

  test("accepts a comma-bearing browser User-Agent and persists a non-bot session", async () => {
    const harness = await httpHarness(root, true);
    await harness.run(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`,
        {
          method: "POST",
          headers: {
            ...writeHeaders("browser_session_request_0001"),
            "User-Agent":
              "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({ visible: true, observedSequence: 5 }),
        },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        session: { excludedAsBot: false },
      });
      expect(harness.interactions.readState().sessions).toHaveLength(1);
      expect(harness.operatorErrors).toEqual([]);
    });
  });

  test("uses the trusted edge address for buckets and fails closed before admission", async () => {
    const resolveClientAddress =
      createReplayPremiereTrustedProxyAddressResolver({
        trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
      });
    const harness = await httpHarness(root, true, { resolveClientAddress });
    await harness.run(async (baseUrl) => {
      const sessionUrl = `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`;
      for (const [index, address] of [
        "198.51.100.11",
        "198.51.100.12",
      ].entries()) {
        const response = await fetch(sessionUrl, {
          method: "POST",
          headers: {
            ...writeHeaders(`edge_session_request_00000${index}`),
            "CF-Connecting-IP": address,
          },
          body: JSON.stringify({ visible: true, observedSequence: 5 }),
        });
        expect(response.status).toBe(201);
        expect(harness.admissions[index]?.requesterBucketId).toBe(
          harness.security.deriveRequesterBucketId(address),
        );
      }
      expect(harness.admissions[0]?.requesterBucketId).not.toBe(
        harness.admissions[1]?.requesterBucketId,
      );

      const admissionCount = harness.admissions.length;
      const rejected = await fetch(sessionUrl, {
        method: "POST",
        headers: {
          ...writeHeaders("edge_session_request_reject1"),
          "CF-Connecting-IP": "ambiguous, 198.51.100.13",
        },
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
      expect(harness.admissions).toHaveLength(admissionCount);
    });
  });

  test("bounds declared and chunked bodies and sanitizes parser/runtime failures", async () => {
    const harness = await httpHarness(root, true, { bodyLimitBytes: 1_024 });
    await harness.run(async (baseUrl) => {
      const sessionPath = `/api/premieres/${PREMIERE_ID}/sessions`;
      const oversized = await fetch(`${baseUrl}${sessionPath}`, {
        method: "POST",
        headers: writeHeaders("oversized_request_00001"),
        body: JSON.stringify({
          visible: true,
          observedSequence: 5,
          pad: "x".repeat(2_000),
        }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({
        error: { code: "PREMIERE_CAPACITY_EXCEEDED" },
      });

      const chunked = await rawChunkedPost(
        baseUrl,
        sessionPath,
        writeHeaders("chunked_request_000001"),
        [
          '{"visible":true,"observedSequence":5,"pad":"',
          "x".repeat(1_200),
          '"}',
        ],
      );
      expect(chunked.status).toBe(413);
      expect(JSON.parse(chunked.body)).toEqual({
        error: { code: "PREMIERE_CAPACITY_EXCEEDED" },
      });

      const malformed = await rawChunkedPost(
        baseUrl,
        sessionPath,
        writeHeaders("malformed_request_0001"),
        ["{not-json"],
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).not.toContain("SyntaxError");
      expect(malformed.body).not.toContain(root);
    });
  });

  test("exposes a revealed archive pointer and rejects every anonymous write with sanitized 410", async () => {
    const harness = await httpHarness(root, true, {
      lifecycleState: "archived",
    });
    await harness.run(async (baseUrl) => {
      expect(harness.runtime.readLifecycleState()).toBe("archived");
      const manifest = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
      ).then((response) => response.json());
      expect(manifest.state).toBe("archived");
      const reveal = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/reveal`,
      );
      expect(reveal.status).toBe(200);
      expect(await reveal.json()).toMatchObject({ state: "revealed" });
      const paths = [
        "sessions",
        "predictions",
        "reactions",
        "shares",
        `sessions/sess_${"a".repeat(32)}/heartbeat`,
      ];
      for (const suffix of paths) {
        const response = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/${suffix}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_INVALID_REQUEST" },
        });
      }
    });
  });

  test("times out a stalled interaction persistence without exposing operator details", async () => {
    const harness = await httpHarness(root, true, {
      hangPersistence: true,
      operationTimeoutMs: 100,
      throwOperatorSink: true,
    });
    await harness.run(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`,
        {
          method: "POST",
          headers: writeHeaders("timeout_request_0000001"),
          body: JSON.stringify({ visible: true, observedSequence: 5 }),
        },
      );
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });
      expect(body).not.toContain("timeout_request");
      expect(body).not.toContain(root);
    });
  });

  test("carries the guest cookie through a timeout so a late commit retry is idempotent", async () => {
    const harness = await httpHarness(root, true, {
      persistenceDelayMs: 175,
      operationTimeoutMs: 100,
    });
    await harness.run(async (baseUrl) => {
      const url = `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`;
      const idempotencyKey = "late_commit_request_0001";
      const body = JSON.stringify({ visible: true, observedSequence: 5 });
      const timedOut = await fetch(url, {
        method: "POST",
        headers: writeHeaders(idempotencyKey),
        body,
      });
      expect(timedOut.status).toBe(503);
      const setCookie = timedOut.headers.get("set-cookie");
      expect(setCookie).toContain("proxywar_premiere_guest=");
      expect(harness.interactions.readState().sessions).toHaveLength(0);

      const retry = await fetch(url, {
        method: "POST",
        headers: writeHeaders(idempotencyKey, setCookie?.split(";", 1)[0]),
        body,
      });
      expect(retry.status).toBe(201);
      const retryBody = await retry.json();
      const state = harness.interactions.readState();
      expect(state.sessions).toHaveLength(1);
      expect(retryBody.session.id).toBe(state.sessions[0].id);
      expect(retryBody.session.participantId).toBe(
        state.sessions[0].participantId,
      );
      expect(retryBody.csrfToken).toEqual(expect.any(String));
    });
  });
});

async function httpHarness(
  root: string,
  revealed: boolean,
  httpOptions: {
    bodyLimitBytes?: number;
    lifecycleState?: PremiereState;
    hangPersistence?: boolean;
    persistenceDelayMs?: number;
    operationTimeoutMs?: number;
    resolveClientAddress?: ReplayPremiereClientAddressResolver;
    throwOperatorSink?: boolean;
  } = {},
) {
  const target = await publicationTarget(
    root,
    revealed,
    httpOptions.lifecycleState,
  );
  const admissions: Parameters<
    ConstructorParameters<
      typeof ReplayPremiereInteractions
    >[0]["admitAnonymousWrite"]
  >[0][] = [];
  let randomByte = 1;
  const security = new ReplayPremiereGuestSecurity({
    hmacKey: Buffer.alloc(32, 7),
    expectedOrigin: EXPECTED_ORIGIN,
    production: true,
    now: () => new Date("2026-07-20T18:00:04.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
  });
  const admitAnonymousWrite: ConstructorParameters<
    typeof ReplayPremiereInteractions
  >[0]["admitAnonymousWrite"] = (request) => {
    admissions.push(structuredClone(request));
  };
  const interactions = new ReplayPremiereInteractions({
    premiereId: PREMIERE_ID,
    checkpointDescriptors: [
      { id: "cp_00000001", sequence: 2 },
      { id: "cp_00000002", sequence: 4 },
    ],
    seats: target.gate.publicDefinition().provenance.seats,
    getPremiereState: () =>
      httpOptions.lifecycleState ?? (revealed ? "revealed" : "playing"),
    getReleasedContext: (sequence) =>
      sequence <= (revealed ? 5 : 4)
        ? {
            releasedThroughSequence: revealed ? 5 : 4,
            turn: sequence,
            eventContext: { released: sequence },
          }
        : null,
    persistence: {
      async persist() {
        if (httpOptions.hangPersistence === true) {
          await new Promise<never>(() => undefined);
        }
        if (httpOptions.persistenceDelayMs !== undefined) {
          await new Promise((resolve) =>
            setTimeout(resolve, httpOptions.persistenceDelayMs),
          );
        }
      },
    },
    signAttribution: (options) => security.signShareAttribution(options),
    canonicalPremiereUrl: `${EXPECTED_ORIGIN}/premiere/${PREMIERE_ID}`,
    now: () => new Date("2026-07-20T18:00:04.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
    admitAnonymousWrite,
  });
  const registry = new ReplayPremiereHttpRegistry(admitAnonymousWrite);
  registry.register({ runtime: target.runtime, interactions });
  const operatorErrors: unknown[] = [];
  const app = express();
  app.use(
    createReplayPremiereRouter({
      registry,
      security,
      bodyLimitBytes: httpOptions.bodyLimitBytes,
      operationTimeoutMs: httpOptions.operationTimeoutMs,
      resolveClientAddress:
        httpOptions.resolveClientAddress ?? (() => "127.0.0.1"),
      onOperatorError: (error) => {
        operatorErrors.push(error);
        if (httpOptions.throwOperatorSink === true) {
          throw new Error("operator sink failure must stay private");
        }
      },
    }),
  );
  app.use((_request, response) => response.status(599).end());
  return {
    security,
    admissions,
    operatorErrors,
    interactions,
    runtime: target.runtime,
    async run(action: (baseUrl: string) => Promise<void>): Promise<void> {
      const server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("test server address unavailable");
      try {
        await action(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        );
      }
    },
  };
}

async function publicationTarget(
  root: string,
  revealed: boolean,
  lifecycleState?: PremiereState,
) {
  const { gate, drafts } = await verifiedPublicationFixture(root);
  const first = gate.releaseNonTerminalChunk({
    draft: drafts[0],
    releasedAt: "2026-07-20T18:00:01.000Z",
    previousChunk: null,
    authoritativeElapsedMs: 100,
  });
  const second = gate.releaseNonTerminalChunk({
    draft: drafts[1],
    releasedAt: "2026-07-20T18:00:02.000Z",
    previousChunk: first,
    authoritativeElapsedMs: 200,
  });
  const terminal = gate.prepareTerminalChunk({
    draft: drafts[2],
    releasedAt: "2026-07-20T18:00:03.000Z",
    previousChunk: second,
    authoritativeElapsedMs: 250,
  });
  let lifecycle = createDraftPremiereLifecycle({
    premiereId: PREMIERE_ID,
    createdAt: NOW.toISOString(),
  });
  lifecycle = transitionPremiereLifecycle(lifecycle, {
    action: "publish",
    actor: "operator",
    occurredAt: NOW.toISOString(),
    gate,
  }).snapshot;
  lifecycle = transitionPremiereLifecycle(lifecycle, {
    action: "start",
    actor: "service",
    occurredAt: NOW.toISOString(),
    serviceReady: true,
  }).snapshot;
  for (let sequence = 0; sequence <= 4; sequence += 1) {
    lifecycle = recordSafeReleasedSequence(
      lifecycle,
      sequence,
      NOW.toISOString(),
    );
  }
  const chunks = [first, second].map((chunk) =>
    toPremierePublicChunkResponse(chunk, gate),
  );
  const manifest: PremierePreRevealManifestResponse = {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "playing",
    serverNow: NOW.toISOString(),
    scheduledAt: NOW.toISOString(),
    actualStartAt: NOW.toISOString(),
    playbackRate: 2,
    authoritativeElapsedMs: 250,
    accumulatedPauseMs: 0,
    releasedThroughSequence: 4,
    lastReleasedChunkIndex: 1,
    activeCheckpoint: null,
    provenance: createPremierePublicProvenance(gate),
    releasedChunks: chunks.map((chunk) => ({
      premiereId: chunk.premiereId,
      index: chunk.index,
      startSequence: chunk.startSequence,
      endSequence: chunk.endSequence,
      startTurn: chunk.startTurn,
      endTurn: chunk.endTurn,
      presentationOffsetMs: chunk.presentationOffsetMs,
      previousChunkHash: chunk.previousChunkHash,
      payloadHash: chunk.payloadHash,
      chunkHash: chunk.chunkHash,
      byteLength: chunk.byteLength,
      terminal: false,
      releasedAt: chunk.releasedAt,
    })),
  };
  const publication = new ReplayPremiereAtomicPublication({
    gate,
    lifecycle,
    manifest,
    releasedChunks: chunks,
  });
  if (revealed) {
    await publication.commitReveal(
      {
        async appendAndSnapshot(input) {
          return durableResult(input);
        },
      },
      { lockedLifecycle: lifecycle, terminal },
    );
  }
  const runtime: ReplayPremiereHttpTarget["runtime"] = {
    premiereId: PREMIERE_ID,
    readLifecycleState: () =>
      lifecycleState ?? (revealed ? "revealed" : "playing"),
    readBootstrap: () => createPremierePublicBootstrap({ gate }),
    readManifest: () => {
      const manifest = publication.readManifest();
      return lifecycleState === "archived" && manifest.state === "revealed"
        ? { ...manifest, state: "archived" }
        : manifest;
    },
    readChunk: (index) => publication.readChunk(index),
    readReveal: () => publication.readReveal(),
  };
  return { gate, runtime };
}

function durableResult(
  input: Parameters<PremiereRevealPersistence["appendAndSnapshot"]>[0],
): { event: StoredReplayPremiereEvent; snapshot: ReplayPremiereSnapshot } {
  const withoutHash = {
    schemaVersion: 1 as const,
    eventSequence: 0,
    eventId: "00000000-0000-4000-8000-000000000000",
    aggregateId: input.event.aggregateId,
    eventType: input.event.eventType,
    occurredAt: input.event.occurredAt,
    payload: input.event.payload,
    idempotencyKey: input.idempotencyKey ?? null,
    idempotencyStateHash: hashReplayPremiereJson(input.state),
    previousEventHash: null,
  };
  const event: StoredReplayPremiereEvent = {
    ...withoutHash,
    eventHash: hashReplayPremiereJson(
      withoutHash as unknown as ReplayPremiereJsonValue,
    ),
  };
  return {
    event,
    snapshot: {
      schemaVersion: 1,
      snapshotKind: "replay_premiere_aggregate",
      aggregateId: input.event.aggregateId,
      lastEventSequence: 0,
      lastEventHash: event.eventHash,
      state: input.state,
      stateHash: hashReplayPremiereJson(input.state),
      writtenAt: input.event.occurredAt,
    },
  };
}

function writeHeaders(
  idempotencyKey: string,
  cookie?: string,
  csrfToken?: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: EXPECTED_ORIGIN,
    "X-Idempotency-Key": idempotencyKey,
    "X-Forwarded-For": "203.0.113.99",
    ...(cookie === undefined ? {} : { Cookie: cookie }),
    ...(csrfToken === undefined ? {} : { "X-CSRF-Token": csrfToken }),
  };
}

async function rawChunkedPost(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string>,
  chunks: readonly string[],
): Promise<{ status: number; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathname,
        method: "POST",
        headers: { ...headers, "Transfer-Encoding": "chunked" },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
