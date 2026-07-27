import express from "express";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs, type StatsFs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  matchProxyWarPublicPremiereReadPath,
  matchProxyWarPublicPremiereWritePath,
} from "../../../src/server/agents/ProxyWarPublicArtifacts";
import {
  createReplayPremiereClipDocumentRouter,
  ReplayPremiereClips,
} from "../../../src/server/replay-premiere/ReplayPremiereClips";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  ReplayPremiereHttpRegistry,
  type ReplayPremiereHttpTarget,
} from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import type { PremiereRevealResponse } from "../../../src/server/replay-premiere/ReplayPremiereWire";

const ID = "prem_0123456789abcdef";
const ORIGIN = "https://beta.proxywar.xyz";
const SOURCE_BYTES = Buffer.from("fixture replay");
const SHA = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const ATTRIBUTION =
  "Game art from OpenFront (openfront.io), CC BY-SA 4.0; footage shared under the same license.";
const NO_ENDORSEMENT =
  "Proxy War is an independent fork — not affiliated with or endorsed by OpenFront.";

// ---------------------------------------------------------------------------
// Matcher grammar (pure)
// ---------------------------------------------------------------------------

describe("clip route matchers", () => {
  test("accepts the exact clip read/write shapes", () => {
    expect(
      matchProxyWarPublicPremiereReadPath(`/api/premieres/${ID}/clips/60`),
    ).toEqual({ kind: "clip_status", premiereId: ID, bucket: 60 });
    expect(
      matchProxyWarPublicPremiereReadPath(`/premiere/${ID}/clip-v1-60.mp4`),
    ).toEqual({ kind: "clip_file", premiereId: ID, bucket: 60 });
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${ID}/clips`),
    ).toEqual({
      kind: "clip",
      premiereId: ID,
    });
  });

  test("rejects traversal, bad bucket grammar, and near-misses", () => {
    for (const bad of [
      `/api/premieres/${ID}/clips/60/../secret`,
      `/api/premieres/${ID}/clips/-1`,
      `/api/premieres/${ID}/clips/007`, // leading zero
      `/api/premieres/${ID}/clips/9999999999`, // 10 digits, out of grammar
      `/api/premieres/${ID}/clips/`,
      `/api/premieres/${ID}/clips/60/`,
      `/premiere/${ID}/clip-v1-60.mp4/../etc`,
      `/premiere/${ID}/clip-v2-60.mp4`, // wrong version
      `/premiere/${ID}/clip-v1-60.webm`,
      `/premiere/${ID}/clip-v1-.mp4`,
      `/premiere/${ID}/../clip-v1-60.mp4`,
      "/api/premieres/prem_short/clips/60",
    ]) {
      expect(matchProxyWarPublicPremiereReadPath(bad)?.kind).not.toBe(
        "clip_status",
      );
      expect(matchProxyWarPublicPremiereReadPath(bad)?.kind).not.toBe(
        "clip_file",
      );
    }
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${ID}/clips/60`),
    ).toBeNull();
    expect(
      matchProxyWarPublicPremiereWritePath(`/api/premieres/${ID}/clip`),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  kill(signal?: string): boolean;
  exitCode: number | null;
};

function fastFakeSpawn() {
  return (jobSpecPath: string) => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.kill = () => true;
    setImmediate(() => {
      void (async () => {
        const spec = JSON.parse(await fs.readFile(jobSpecPath, "utf8"));
        const bytes = Buffer.from(`clip-${spec.anchorTurn}-bytes`);
        await fs.writeFile(path.join(spec.outDir, "clip.mp4"), bytes);
        await fs.writeFile(
          path.join(spec.outDir, "render-manifest.json"),
          JSON.stringify({
            premiereId: spec.premiereId,
            sourceReplaySha256: spec.expectedBundleSha256,
            anchorTurn: spec.anchorTurn,
            clipVersion: spec.clipVersion,
            frameShape: "square",
            frameWidth: 1080,
            frameHeight: 1080,
            outSha256: createHash("sha256").update(bytes).digest("hex"),
            outBytes: bytes.length,
            generatedAt: new Date().toISOString(),
          }),
        );
        child.exitCode = 0;
        child.emit("exit", 0);
      })();
    });
    return child as never;
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pw-cliproutes-"));
  const sourcePath = path.join(
    root,
    "sources",
    "sha256",
    SHA.slice(0, 2),
    `${SHA}.replay`,
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, SOURCE_BYTES);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function buildHarness(
  state: PremiereState,
  options: { withClips?: boolean } = {},
) {
  let randomByte = 1;
  const security = new ReplayPremiereGuestSecurity({
    hmacKey: Buffer.alloc(32, 7),
    expectedOrigin: ORIGIN,
    production: true,
    now: () => new Date("2026-07-20T18:00:04.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
  });
  const admit = () => undefined;
  const runtime: ReplayPremiereHttpTarget["runtime"] = {
    premiereId: ID,
    readLifecycleState: () => state,
    readBootstrap: () =>
      ({ provenance: { sourceReplaySha256: SHA } }) as ReturnType<
        ReplayPremiereHttpTarget["runtime"]["readBootstrap"]
      >,
    readManifest: async () =>
      ({
        state,
        releasedThroughSequence: 10_000,
      }) as Awaited<
        ReturnType<ReplayPremiereHttpTarget["runtime"]["readManifest"]>
      >,
    readChunk: () => null,
    readReveal: () =>
      state === "revealed" || state === "archived"
        ? ({
            sourceReplaySha256: SHA,
            finalSequence: 10_000,
          } as unknown as PremiereRevealResponse)
        : null,
    readReleasedContext: (sequence) =>
      sequence >= 0 && sequence <= 10_000
        ? {
            releasedThroughSequence: 10_000,
            turn: sequence,
            eventContext: null,
          }
        : null,
    readLiveVisibleSequence: () => 10_000,
    readLiveProjection: () => [],
  };
  const interactions = {
    usesAnonymousWriteAdmission: (candidate: unknown) => candidate === admit,
    readState: () => ({ reactions: [] }),
  } as unknown as ReplayPremiereHttpTarget["interactions"];
  const registry = new ReplayPremiereHttpRegistry(admit);
  registry.register({ runtime, interactions });

  const clips = options.withClips
    ? new ReplayPremiereClips({
        clipsRoot: path.join(root, "clips-v1"),
        sourceBundleRoot: root,
        staticDir: path.join(root, "static"),
        workerModulePath: path.join(root, "worker.ts"),
        publicOrigin: ORIGIN,
        licenseStrings: {
          attribution: ATTRIBUTION,
          noEndorsement: NO_ENDORSEMENT,
        },
        storageStatePath: path.join(root, "state.json"),
        statfs: (async () => ({
          bavail: 100 * 1024 ** 3,
          bsize: 1,
        })) as unknown as (p: string) => Promise<StatsFs>,
        spawnWorker: fastFakeSpawn(),
      })
    : undefined;

  const app = express();
  app.use(
    createReplayPremiereRouter({
      registry,
      security,
      clips,
      resolveClientAddress: () => "127.0.0.1",
      onOperatorError: () => undefined,
    }),
  );
  if (clips !== undefined) {
    app.use(
      createReplayPremiereClipDocumentRouter({
        clips,
        resolveLifecycle: (premiereId) =>
          registry.get(premiereId)?.runtime ?? null,
      }),
    );
  }
  app.use((_request, response) => response.status(599).end());

  const guest = security.bootstrap(undefined);
  const cookie = (guest.setCookie ?? "").split(";")[0];
  return {
    clips,
    cookie,
    csrfToken: guest.csrfToken,
    async run(action: (baseUrl: string) => Promise<void>): Promise<void> {
      const server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("no test server address");
      }
      try {
        await action(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await clips?.close();
      }
    },
  };
}

function clipHeaders(
  key: string,
  cookie?: string,
  csrfToken?: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    "X-Idempotency-Key": key,
    ...(cookie === undefined ? {} : { Cookie: cookie }),
    ...(csrfToken === undefined ? {} : { "X-CSRF-Token": csrfToken }),
  };
}

async function pollReady(baseUrl: string, cookie: string, bucket: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const response = await fetch(
      `${baseUrl}/api/premieres/${ID}/clips/${bucket}`,
      { headers: { Cookie: cookie } },
    );
    if (response.status === 200) {
      const body = await response.json();
      if (body.state === "ready") return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("clip never became ready over HTTP");
}

// ---------------------------------------------------------------------------
// Replay-scoped live range
// ---------------------------------------------------------------------------

describe("in-progress replay clipping", () => {
  test("clip status GET is a bare 404 while playing", async () => {
    const harness = buildHarness("playing", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips/60`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });
    });
  });

  test("clip file GET is a bare 404 while playing", async () => {
    const harness = buildHarness("playing", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${ID}/clip-v1-60.mp4`);
      expect(response.status).toBe(404);
    });
  });

  test("clips an already-released live range and rejects a future-leaking tail", async () => {
    const harness = buildHarness("playing", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_000000000000001",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).state).toBe("pending");

      const unreleased = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_000000000000009",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 9_900, turn: 9_900 }),
      });
      expect(unreleased.status).toBe(410);
      expect(await unreleased.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
    });
  });

  test("clip routes 404 when clips are disabled (gate off)", async () => {
    const harness = buildHarness("revealed", { withClips: false });
    await harness.run(async (baseUrl) => {
      const status = await fetch(`${baseUrl}/api/premieres/${ID}/clips/60`);
      expect(status.status).toBe(404);
      const post = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_000000000000002",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(post.status).toBe(404);
    });
  });

  test("keeps the registered archived Premiere cache fenced", async () => {
    const harness = buildHarness("archived", { withClips: true });
    await harness.run(async (baseUrl) => {
      const status = await fetch(`${baseUrl}/api/premieres/${ID}/clips/60`);
      expect(status.status).toBe(404);
      expect(await status.json()).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });

      const post = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_archived000001",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(post.status).toBe(410);
      expect(await post.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Envelope parity
// ---------------------------------------------------------------------------

describe("clip POST envelope parity", () => {
  test("missing CSRF is 403", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders("clip_req_000000000000010", harness.cookie),
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
    });
  });

  test("wrong content-type is 415", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: ORIGIN,
          "X-Idempotency-Key": "clip_req_000000000000011",
          Cookie: harness.cookie,
          "X-CSRF-Token": harness.csrfToken,
        },
        body: "sequence=605",
      });
      expect(response.status).toBe(415);
    });
  });

  test("missing idempotency key is 400", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: harness.cookie,
          "X-CSRF-Token": harness.csrfToken,
        },
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(response.status).toBe(400);
    });
  });

  test("bad Origin is 403", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "X-Idempotency-Key": "clip_req_000000000000012",
          Cookie: harness.cookie,
          "X-CSRF-Token": harness.csrfToken,
        },
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(response.status).toBe(403);
    });
  });

  test("a rejected anchor form is a 400 invalid request", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_000000000000013",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 605 }), // turn missing
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "PREMIERE_INVALID_REQUEST" },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path + mp4 document headers
// ---------------------------------------------------------------------------

describe("revealed happy path and mp4 document headers", () => {
  test("POST renders, status turns ready, and the mp4 serves with the right headers", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const post = await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_000000000000020",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      expect(post.status).toBe(200);
      const posted = await post.json();
      expect(posted).toMatchObject({
        schemaVersion: 1,
        premiereId: ID,
        bucket: 60,
      });

      const ready = await pollReady(baseUrl, harness.cookie, 60);
      expect(ready.state).toBe("ready");
      expect(ready.ready.clipUrl).toBe(`/premiere/${ID}/clip-v1-60.mp4`);
      expect(ready.ready.social.caption).toContain("CC BY-SA 4.0");
      expect(ready.ready.social.caption).not.toContain("https://");

      const mp4 = await fetch(`${baseUrl}/premiere/${ID}/clip-v1-60.mp4`);
      expect(mp4.status).toBe(200);
      expect(mp4.headers.get("content-type")).toBe("video/mp4");
      expect(mp4.headers.get("content-disposition")).toContain("attachment");
      expect(mp4.headers.get("content-disposition")).toContain(
        "clip-v1-60.mp4",
      );
      expect(mp4.headers.get("x-content-type-options")).toBe("nosniff");
      expect(mp4.headers.get("cache-control")).toContain("no-store");
      const bytes = Buffer.from(await mp4.arrayBuffer());
      expect(Number(mp4.headers.get("content-length"))).toBe(bytes.length);
      expect(bytes.length).toBeGreaterThan(0);

      // HEAD returns the same headers with no body.
      const head = await fetch(`${baseUrl}/premiere/${ID}/clip-v1-60.mp4`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get("content-length"))).toBe(bytes.length);
      expect((await head.text()).length).toBe(0);
    });
  });

  test("a Range request on the mp4 is refused", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      await fetch(`${baseUrl}/api/premieres/${ID}/clips`, {
        method: "POST",
        headers: clipHeaders(
          "clip_req_000000000000021",
          harness.cookie,
          harness.csrfToken,
        ),
        body: JSON.stringify({ sequence: 605, turn: 605 }),
      });
      await pollReady(baseUrl, harness.cookie, 60);
      const ranged = await fetch(`${baseUrl}/premiere/${ID}/clip-v1-60.mp4`, {
        headers: { Range: "bytes=0-3" },
      });
      expect(ranged.status).toBe(416);
    });
  });

  test("the mp4 is a 404 for a revealed premiere with no cached clip", async () => {
    const harness = buildHarness("revealed", { withClips: true });
    await harness.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${ID}/clip-v1-77.mp4`);
      expect(response.status).toBe(404);
    });
  });
});
