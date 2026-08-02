import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { freezeReplayPremiereCheckpointProjection } from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import {
  createReplayPremiereTrustedProxyAddressResolver,
  REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
  type ReplayPremiereClientAddressResolver,
} from "../../../src/server/replay-premiere/ReplayPremiereClientAddress";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import type {
  ReplayPremiereEventRecovery,
  ReplayPremiereSnapshot,
  StoredReplayPremiereEvent,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
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
  ReplayPremiereRuntimeCoordinator,
  type ReplayPremiereRuntimeClock,
  type ReplayPremiereRuntimePersistence,
} from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
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

// Frozen top-level c8b5 v3 parsers. The old client used strict schemas, so an
// additive key is a wire incompatibility even when every existing field is
// otherwise valid.
const frozenC8b5SessionV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    csrfToken: z.unknown(),
    session: z.unknown(),
    created: z.unknown(),
    premiereState: z.unknown(),
    checkpoints: z.unknown(),
    incomingMoment: z.unknown(),
    clipsEnabled: z.unknown(),
    reactionSummary: z.unknown(),
    latestOwnReaction: z.unknown(),
  })
  .strict();
const frozenC8b5HeartbeatV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    session: z.unknown(),
    idempotent: z.unknown(),
    persisted: z.unknown(),
    premiereState: z.unknown(),
    checkpoints: z.unknown(),
    clipsEnabled: z.unknown(),
    reactionSummary: z.unknown(),
    latestOwnReaction: z.unknown(),
  })
  .strict();
const frozenC8b5ReactionV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    reaction: z.unknown(),
    idempotent: z.unknown(),
    clipsEnabled: z.unknown(),
    reactionSummary: z.unknown(),
    latestOwnReaction: z.unknown(),
  })
  .strict();

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

  test("linearizes the checkpoint-close manifest through HTTP while durable resume is pending", async () => {
    const harness = await liveRuntimeHttpHarness(root);
    try {
      await harness.runtime.synchronize();
      harness.clock.advance(100);
      await harness.runtime.synchronize();
      const checkpoint = harness.runtime.readActiveCheckpoint();
      expect(checkpoint).not.toBeNull();
      const eventCountAtOpen = harness.store.recovered.events.length;

      await harness.run(async (baseUrl) => {
        harness.clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS - 1);
        const beforeClose = await readJson(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
        );
        expect(beforeClose).toMatchObject({
          status: 200,
          body: {
            state: "checkpoint",
            activeCheckpoint: { id: checkpoint!.id, state: "open" },
            releasedThroughSequence: 2,
          },
        });

        const blockedResume = harness.persistence.blockNext(
          "premiere_runtime_checkpoint_resumed",
        );
        harness.clock.advance(1);
        const resume = harness.runtime.synchronize();
        await blockedResume.started;

        const atClose = readJson(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
        );
        expect(harness.runtime.readLifecycleState()).toBe("checkpoint");
        expect(harness.store.recovered.events).toHaveLength(eventCountAtOpen);
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/chunks/1`),
        ).toEqual({
          status: 404,
          body: { error: { code: "PREMIERE_UNAVAILABLE" } },
        });
        expect(harness.store.recovered.events).toHaveLength(eventCountAtOpen);

        blockedResume.release();
        await resume;
        expect(await atClose).toMatchObject({
          status: 200,
          body: {
            state: "playing",
            serverNow: checkpoint!.closesAt,
            authoritativeElapsedMs: 100,
            accumulatedPauseMs: REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
            activeCheckpoint: null,
            releasedThroughSequence: 2,
          },
        });
        expect(harness.runtime.readLifecycleState()).toBe("playing");
        expect(
          harness.store.recovered.events.filter(
            (event) =>
              event.eventType === "premiere_runtime_checkpoint_resumed",
          ),
        ).toHaveLength(1);
      });
    } finally {
      await harness.close();
    }
  });

  test("keeps reveal and terminal chunk unavailable until the atomic reveal event is durable", async () => {
    const harness = await liveRuntimeHttpHarness(root);
    try {
      await harness.runtime.synchronize();
      harness.clock.advance(100);
      await harness.runtime.synchronize();
      harness.clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
      await harness.runtime.synchronize();
      harness.clock.advance(100);
      await harness.runtime.synchronize();
      harness.clock.advance(REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS);
      await harness.runtime.synchronize();

      await harness.run(async (baseUrl) => {
        harness.clock.advance(49);
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`),
        ).toMatchObject({ status: 200, body: { state: "playing" } });
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/reveal`),
        ).toEqual({
          status: 404,
          body: { error: { code: "PREMIERE_UNAVAILABLE" } },
        });

        const blockedReveal = harness.persistence.blockNext(
          "premiere_reveal_committed",
        );
        harness.clock.advance(1);
        const reveal = harness.runtime.synchronize();
        await blockedReveal.started;
        const manifestDuringCommit = readJson(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
        );
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/reveal`),
        ).toEqual({
          status: 404,
          body: { error: { code: "PREMIERE_UNAVAILABLE" } },
        });
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/chunks/2`),
        ).toEqual({
          status: 404,
          body: { error: { code: "PREMIERE_UNAVAILABLE" } },
        });

        blockedReveal.release();
        await reveal;
        expect(await manifestDuringCommit).toMatchObject({
          status: 200,
          body: {
            state: "revealed",
            revealedAt: harness.clock.now().toISOString(),
          },
        });
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`),
        ).toMatchObject({
          status: 200,
          body: {
            state: "revealed",
            revealedAt: harness.clock.now().toISOString(),
          },
        });
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/reveal`),
        ).toMatchObject({ status: 200, body: { state: "revealed" } });
        expect(
          await readJson(`${baseUrl}/api/premieres/${PREMIERE_ID}/chunks/2`),
        ).toMatchObject({
          status: 200,
          body: { index: 2, terminal: true },
        });
        expect(
          harness.store.recovered.events.filter(
            (event) => event.eventType === "premiere_reveal_committed",
          ),
        ).toHaveLength(1);
      });
    } finally {
      await harness.close();
    }
  });

  test("negotiates v4 clip eligibility while requiring reload-safe CSRF, cookie, Origin, and token", async () => {
    const harness = await httpHarness(root, true);
    await harness.run(async (baseUrl) => {
      const sessionUrl = `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`;
      const sessionResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders(
          "session_request_00000001",
          undefined,
          undefined,
          "4",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(harness.operatorErrors).toEqual([]);
      expect(sessionResponse.status).toBe(201);
      const cookie = sessionResponse.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      const sessionBody = await sessionResponse.json();
      expect(Object.keys(sessionBody).sort()).toEqual(
        [
          "schemaVersion",
          "csrfToken",
          "session",
          "created",
          "premiereState",
          "checkpoints",
          "incomingMoment",
          "clipsEnabled",
          "clipEligibility",
          "reactionSummary",
          "latestOwnReaction",
        ].sort(),
      );
      expect(sessionBody).toMatchObject({
        schemaVersion: 4,
        csrfToken: expect.any(String),
        incomingMoment: null,
        premiereState: "revealed",
        latestOwnReaction: null,
        clipsEnabled: false,
        clipEligibility: {
          generationEnabled: false,
          renderableThroughTurn: null,
          sourceComplete: false,
        },
        session: { premiereId: PREMIERE_ID },
        reactionSummary: {
          totalReactions: 0,
          distinctParticipants: 0,
          byKind: {
            turning_point: 0,
            smart: 0,
            mistake: 0,
            betrayal: 0,
            clip_this: 0,
          },
          ownByKind: {
            turning_point: 0,
            smart: 0,
            mistake: 0,
            betrayal: 0,
            clip_this: 0,
          },
        },
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
          "4",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(heartbeat.status).toBe(200);
      const heartbeatBody = await heartbeat.json();
      expect(Object.keys(heartbeatBody).sort()).toEqual(
        [
          "schemaVersion",
          "session",
          "idempotent",
          "persisted",
          "premiereState",
          "checkpoints",
          "clipsEnabled",
          "clipEligibility",
          "reactionSummary",
          "latestOwnReaction",
        ].sort(),
      );
      expect(heartbeatBody).toMatchObject({
        schemaVersion: 4,
        persisted: false,
        latestOwnReaction: null,
        clipsEnabled: false,
        clipEligibility: {
          generationEnabled: false,
          renderableThroughTurn: null,
          sourceComplete: false,
        },
        reactionSummary: {
          totalReactions: 0,
          distinctParticipants: 0,
        },
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
              "4",
            ),
            body: JSON.stringify({
              sessionId: sessionBody.session.id,
              sequence: index,
              kind,
            }),
          },
        );
        expect(reaction.status).toBe(200);
        const reactionBody = await reaction.json();
        expect(Object.keys(reactionBody).sort()).toEqual(
          [
            "schemaVersion",
            "reaction",
            "idempotent",
            "clipsEnabled",
            "clipEligibility",
            "reactionSummary",
            "latestOwnReaction",
          ].sort(),
        );
        expect(reactionBody).toMatchObject({
          schemaVersion: 4,
          reaction: { kind },
          latestOwnReaction: {
            id: reactionBody.reaction.id,
            kind,
            sequence: index,
            turn: index,
          },
          clipsEnabled: false,
          clipEligibility: {
            generationEnabled: false,
            renderableThroughTurn: null,
            sourceComplete: false,
          },
          reactionSummary: {
            totalReactions: index + 1,
            distinctParticipants: 1,
            byKind: { [kind]: 1 },
            ownByKind: { [kind]: 1 },
          },
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
        headers: writeHeaders(
          "session_request_00000002",
          cookie ?? undefined,
          undefined,
          "2",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(reload.status).toBe(201);
      const reloadBody = await reload.json();
      expect(reloadBody.csrfToken).toEqual(expect.any(String));
      expect(reloadBody).not.toHaveProperty("latestOwnReaction");

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

  test("preserves the frozen c8b5 v3 session, heartbeat, and reaction shapes", async () => {
    const harness = await httpHarness(root, true);
    await harness.run(async (baseUrl) => {
      const sessionUrl = `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`;
      const sessionAResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders(
          "v3_session_request_000001",
          undefined,
          undefined,
          "3",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(sessionAResponse.status).toBe(201);
      const cookieA = sessionAResponse.headers.get("set-cookie") ?? undefined;
      const sessionA = await sessionAResponse.json();
      expect(Object.keys(sessionA).sort()).toEqual(
        [
          "schemaVersion",
          "csrfToken",
          "session",
          "created",
          "premiereState",
          "checkpoints",
          "incomingMoment",
          "clipsEnabled",
          "reactionSummary",
          "latestOwnReaction",
        ].sort(),
      );
      expect(sessionA).not.toHaveProperty("clipEligibility");
      expect(() => frozenC8b5SessionV3Schema.parse(sessionA)).not.toThrow();
      expect(sessionA).toMatchObject({
        schemaVersion: 3,
        latestOwnReaction: null,
      });

      const reactionAResponse = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/reactions`,
        {
          method: "POST",
          headers: writeHeaders(
            "v3_reaction_request_a001",
            cookieA,
            sessionA.csrfToken,
            "3",
          ),
          body: JSON.stringify({
            sessionId: sessionA.session.id,
            sequence: 2,
            kind: "smart",
          }),
        },
      );
      expect(reactionAResponse.status).toBe(200);
      const reactionA = await reactionAResponse.json();
      expect(Object.keys(reactionA).sort()).toEqual(
        [
          "schemaVersion",
          "reaction",
          "idempotent",
          "clipsEnabled",
          "reactionSummary",
          "latestOwnReaction",
        ].sort(),
      );
      expect(reactionA).not.toHaveProperty("clipEligibility");
      expect(() => frozenC8b5ReactionV3Schema.parse(reactionA)).not.toThrow();
      const anchorA = {
        id: reactionA.reaction.id,
        kind: "smart",
        sequence: 2,
        turn: 2,
      };
      expect(reactionA).toMatchObject({
        schemaVersion: 3,
        latestOwnReaction: anchorA,
      });
      expect(Object.keys(reactionA.latestOwnReaction).sort()).toEqual(
        ["id", "kind", "sequence", "turn"].sort(),
      );
      expect(Object.keys(reactionA.reactionSummary).sort()).toEqual(
        [
          "totalReactions",
          "distinctParticipants",
          "byKind",
          "ownByKind",
        ].sort(),
      );

      const reloadAResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders(
          "v3_session_reload_a00001",
          cookieA,
          undefined,
          "3",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(reloadAResponse.status).toBe(201);
      const reloadA = await reloadAResponse.json();
      expect(reloadA.session.participantId).toBe(
        sessionA.session.participantId,
      );
      expect(reloadA.latestOwnReaction).toEqual(anchorA);

      const sessionBResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders(
          "v3_session_request_000002",
          undefined,
          undefined,
          "3",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(sessionBResponse.status).toBe(201);
      const cookieB = sessionBResponse.headers.get("set-cookie") ?? undefined;
      const sessionB = await sessionBResponse.json();
      expect(sessionB.session.participantId).not.toBe(
        sessionA.session.participantId,
      );
      expect(sessionB.latestOwnReaction).toBeNull();

      const reactionBResponse = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/reactions`,
        {
          method: "POST",
          headers: writeHeaders(
            "v3_reaction_request_b001",
            cookieB,
            sessionB.csrfToken,
            "3",
          ),
          body: JSON.stringify({
            sessionId: sessionB.session.id,
            sequence: 3,
            kind: "mistake",
          }),
        },
      );
      expect(reactionBResponse.status).toBe(200);
      const reactionB = await reactionBResponse.json();
      expect(reactionB.latestOwnReaction).toEqual({
        id: reactionB.reaction.id,
        kind: "mistake",
        sequence: 3,
        turn: 3,
      });
      expect(reactionB.latestOwnReaction).not.toEqual(anchorA);

      const heartbeatAResponse = await fetch(
        `${sessionUrl}/${sessionA.session.id}/heartbeat`,
        {
          method: "POST",
          headers: writeHeaders(
            "v3_heartbeat_request_a01",
            cookieA,
            reloadA.csrfToken,
            "3",
          ),
          body: JSON.stringify({ visible: true, observedSequence: 5 }),
        },
      );
      expect(heartbeatAResponse.status).toBe(200);
      const heartbeatA = await heartbeatAResponse.json();
      expect(Object.keys(heartbeatA).sort()).toEqual(
        [
          "schemaVersion",
          "session",
          "idempotent",
          "persisted",
          "premiereState",
          "checkpoints",
          "clipsEnabled",
          "reactionSummary",
          "latestOwnReaction",
        ].sort(),
      );
      expect(heartbeatA).not.toHaveProperty("clipEligibility");
      expect(() => frozenC8b5HeartbeatV3Schema.parse(heartbeatA)).not.toThrow();
      expect(heartbeatA).toMatchObject({
        schemaVersion: 3,
        latestOwnReaction: anchorA,
      });

      const v2ReloadResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders(
          "v2_session_reload_a00001",
          cookieA,
          undefined,
          "2",
        ),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(v2ReloadResponse.status).toBe(201);
      const v2Reload = await v2ReloadResponse.json();
      expect(Object.keys(v2Reload).sort()).toEqual(
        [
          "schemaVersion",
          "csrfToken",
          "session",
          "created",
          "premiereState",
          "checkpoints",
          "incomingMoment",
          "clipsEnabled",
          "reactionSummary",
        ].sort(),
      );
      expect(v2Reload.schemaVersion).toBe(2);
      expect(v2Reload).not.toHaveProperty("latestOwnReaction");
      expect(v2Reload).not.toHaveProperty("clipEligibility");
    });
  });

  test("keeps legacy v1 interaction response shapes without exact v2 negotiation", async () => {
    const harness = await httpHarness(root, true);
    await harness.run(async (baseUrl) => {
      const sessionUrl = `${baseUrl}/api/premieres/${PREMIERE_ID}/sessions`;
      const sessionResponse = await fetch(sessionUrl, {
        method: "POST",
        headers: writeHeaders("legacy_session_request_001"),
        body: JSON.stringify({ visible: true, observedSequence: 5 }),
      });
      expect(sessionResponse.status).toBe(201);
      const cookie = sessionResponse.headers.get("set-cookie") ?? undefined;
      const sessionBody = await sessionResponse.json();
      expect(Object.keys(sessionBody).sort()).toEqual(
        [
          "schemaVersion",
          "csrfToken",
          "session",
          "created",
          "premiereState",
          "checkpoints",
          "incomingMoment",
        ].sort(),
      );
      expect(sessionBody.schemaVersion).toBe(1);
      expect(sessionBody).not.toHaveProperty("reactionSummary");
      expect(sessionBody).not.toHaveProperty("clipsEnabled");

      const heartbeatResponse = await fetch(
        `${sessionUrl}/${sessionBody.session.id}/heartbeat`,
        {
          method: "POST",
          headers: writeHeaders(
            "legacy_heartbeat_request01",
            cookie,
            sessionBody.csrfToken,
            "unexpected",
          ),
          body: JSON.stringify({ visible: true, observedSequence: 5 }),
        },
      );
      expect(heartbeatResponse.status).toBe(200);
      const heartbeatBody = await heartbeatResponse.json();
      expect(Object.keys(heartbeatBody).sort()).toEqual(
        [
          "schemaVersion",
          "session",
          "idempotent",
          "persisted",
          "premiereState",
          "checkpoints",
        ].sort(),
      );
      expect(heartbeatBody.schemaVersion).toBe(1);
      expect(heartbeatBody).not.toHaveProperty("reactionSummary");
      expect(heartbeatBody).not.toHaveProperty("clipsEnabled");

      const reactionResponse = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/reactions`,
        {
          method: "POST",
          headers: writeHeaders(
            "legacy_reaction_request001",
            cookie,
            sessionBody.csrfToken,
            "2, 3",
          ),
          body: JSON.stringify({
            sessionId: sessionBody.session.id,
            sequence: 0,
            kind: "smart",
          }),
        },
      );
      expect(reactionResponse.status).toBe(200);
      const reactionBody = await reactionResponse.json();
      expect(Object.keys(reactionBody).sort()).toEqual(
        ["schemaVersion", "reaction", "idempotent"].sort(),
      );
      expect(reactionBody.schemaVersion).toBe(1);
      expect(reactionBody).not.toHaveProperty("reactionSummary");
      expect(reactionBody).not.toHaveProperty("clipsEnabled");
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
        "clips",
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

  test("times out a stalled manifest read barrier with a sanitized failure", async () => {
    const harness = await httpHarness(root, false, {
      hangManifest: true,
      operationTimeoutMs: 100,
      throwOperatorSink: true,
    });
    await harness.run(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
      );
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });
      expect(body).not.toContain(root);
      expect(body).not.toContain("premiere_operation_timeout");
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

class FakeHttpRuntimeClock implements ReplayPremiereRuntimeClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

class GateableRuntimePersistence implements ReplayPremiereRuntimePersistence {
  readonly recovered: ReplayPremiereEventRecovery;
  private blocked: {
    eventType: string;
    started: () => void;
    wait: Promise<void>;
    release: () => void;
  } | null = null;

  constructor(private readonly store: ReplayPremiereEventStore) {
    this.recovered = store.recovered;
  }

  readSnapshot(aggregateId: string): Promise<ReplayPremiereSnapshot | null> {
    return this.store.readSnapshot(aggregateId);
  }

  async appendAndSnapshot(
    options: Parameters<
      ReplayPremiereRuntimePersistence["appendAndSnapshot"]
    >[0],
  ): ReturnType<ReplayPremiereRuntimePersistence["appendAndSnapshot"]> {
    const blocked = this.blocked;
    if (blocked?.eventType === options.event.eventType) {
      blocked.started();
      await blocked.wait;
      if (this.blocked === blocked) this.blocked = null;
    }
    return this.store.appendAndSnapshot(options);
  }

  blockNext(eventType: string): {
    started: Promise<void>;
    release: () => void;
  } {
    if (this.blocked !== null) throw new Error("persistence already blocked");
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.blocked = {
      eventType,
      started: markStarted,
      wait,
      release,
    };
    return { started, release };
  }

  releaseBlocked(): void {
    this.blocked?.release();
    this.blocked = null;
  }
}

async function liveRuntimeHttpHarness(root: string) {
  const { gate, drafts } = await verifiedPublicationFixture(root);
  const clock = new FakeHttpRuntimeClock(NOW);
  const servedRoot = path.join(root, "live-runtime-served");
  await fs.mkdir(servedRoot, { recursive: true });
  const store = await ReplayPremiereEventStore.open({
    privateStateRoot: path.join(root, "live-runtime-private"),
    servedRoots: [servedRoot],
    limits: {
      maxEventBytes: 2_000_000,
      maxAggregateEventBytes: 20_000_000,
      maxEventLogBytes: 30_000_000,
      maxSnapshotBytes: 5_000_000,
      maxPrivateStateBytes: 50_000_000,
    },
  });
  const persistence = new GateableRuntimePersistence(store);
  const admitAnonymousWrite: ConstructorParameters<
    typeof ReplayPremiereInteractions
  >[0]["admitAnonymousWrite"] = () => undefined;
  let runtime: ReplayPremiereRuntimeCoordinator | null = null;
  const definition = gate.publicDefinition();
  const interactions = new ReplayPremiereInteractions({
    premiereId: PREMIERE_ID,
    checkpointDescriptors: definition.checkpoints,
    seats: definition.provenance.seats,
    getPremiereState: () => runtime?.readLifecycleState() ?? "scheduled",
    getReleasedContext: (sequence) =>
      runtime?.readReleasedContext(sequence) ?? null,
    getLiveVisibleSequence: () => runtime?.readLiveVisibleSequence() ?? 0,
    persistence: { persist: async () => undefined },
    signAttribution: () => "a".repeat(64),
    canonicalPremiereUrl: `${EXPECTED_ORIGIN}/premieres/${PREMIERE_ID}`,
    now: () => clock.now(),
    admitAnonymousWrite,
  });
  const optionSeatIds = definition.provenance.seats.map((seat) => seat.seatId);
  runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
    gate,
    drafts,
    checkpointProjection: freezeReplayPremiereCheckpointProjection({
      premiereId: PREMIERE_ID,
      publicationCommitmentHash: gate.publicationCommitmentHash,
      checkpoints: [
        { ...definition.checkpoints[0], optionSeatIds },
        { ...definition.checkpoints[1], optionSeatIds },
      ],
    }),
    persistence,
    clock,
    interactions,
  });
  const registry = new ReplayPremiereHttpRegistry(admitAnonymousWrite);
  registry.register({ runtime, interactions });
  const security = new ReplayPremiereGuestSecurity({
    hmacKey: Buffer.alloc(32, 7),
    expectedOrigin: EXPECTED_ORIGIN,
    production: true,
    now: () => clock.now(),
  });
  const app = express();
  app.use(
    createReplayPremiereRouter({
      registry,
      security,
      resolveClientAddress: () => "127.0.0.1",
    }),
  );
  app.use((_request, response) => response.status(599).end());
  return {
    clock,
    persistence,
    runtime,
    store,
    async run(action: (baseUrl: string) => Promise<void>): Promise<void> {
      const server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server address unavailable");
      }
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
    async close(): Promise<void> {
      persistence.releaseBlocked();
      await store.close();
    },
  };
}

async function readJson(
  url: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function httpHarness(
  root: string,
  revealed: boolean,
  httpOptions: {
    bodyLimitBytes?: number;
    lifecycleState?: PremiereState;
    hangManifest?: boolean;
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
  if (httpOptions.hangManifest === true) {
    target.runtime.readManifest = async () =>
      new Promise<never>(() => undefined);
  }
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
    getLiveVisibleSequence: () => (revealed ? 5 : 4),
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
    readManifest: async () => {
      const manifest = publication.readManifest();
      return lifecycleState === "archived" && manifest.state === "revealed"
        ? { ...manifest, state: "archived" }
        : manifest;
    },
    readChunk: (index) => publication.readChunk(index),
    readReveal: () => publication.readReveal(),
    readReleasedContext: (sequence) => {
      const releasedThroughSequence = revealed ? 5 : 4;
      return sequence >= 0 && sequence <= releasedThroughSequence
        ? { releasedThroughSequence, turn: sequence, eventContext: null }
        : null;
    },
    readLiveVisibleSequence: () => (revealed ? 5 : 4),
    readLiveProjection: () => [],
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
  interactionVersion?: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: EXPECTED_ORIGIN,
    "X-Idempotency-Key": idempotencyKey,
    "X-Forwarded-For": "203.0.113.99",
    ...(cookie === undefined ? {} : { Cookie: cookie }),
    ...(csrfToken === undefined ? {} : { "X-CSRF-Token": csrfToken }),
    ...(interactionVersion === undefined
      ? {}
      : { "X-ProxyWar-Premiere-Interactions": interactionVersion }),
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
