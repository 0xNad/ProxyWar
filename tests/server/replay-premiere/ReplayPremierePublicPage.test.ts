import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  type ReplayPremiereHttpRegistry,
  type ReplayPremiereHttpTarget,
} from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  createReplayPremierePublicPageRouter,
  renderReplayPremiereCardSvg,
  renderReplayPremierePageHtml,
} from "../../../src/server/replay-premiere/ReplayPremierePublicPage";
import {
  createPremierePublicBootstrap,
  type PremierePreRevealManifestResponse,
  type PremierePublicBootstrapResponse,
} from "../../../src/server/replay-premiere/ReplayPremiereWire";
import {
  NOW,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

const PUBLIC_ORIGIN = "https://beta.proxywar.xyz";

// Same fallback shape as `GamePreviewRoute.ts`'s app-shell resolution:
// prefer the built `static/index.html` when present, fall back to the
// tracked source `index.html` when it isn't (e.g. no `vite build` has run
// yet, as in a Test CI job that only does `npm ci`). The tracked root
// `index.html` already carries the same `<head>` shape this test needs —
// OG/Twitter meta tags to be replaced, plus the inline
// `window.BOOTSTRAP_CONFIG = {...}` script `createPremierePublicBootstrap`
// looks for — so this test has no real build dependency.
async function resolveAppShellPath(): Promise<string> {
  const staticHtml = path.resolve("static/index.html");
  try {
    await fs.access(staticHtml);
    return staticHtml;
  } catch {
    return path.resolve("index.html");
  }
}
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
const TEST_SCRIPT_NONCE = "A".repeat(32);

describe("ReplayPremiere public page and card", () => {
  let root: string;
  const servers: http.Server[] = [];

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(
      path.join(realTemporaryRoot, "premiere-public-page-"),
    );
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  test("serves spoiler-neutral page metadata and SVG before and after reveal", async () => {
    const harness = await createHarness(root);
    await harness.run(async (baseUrl) => {
      const routes = [
        `/premiere/${PREMIERE_ID}`,
        `/premiere/${PREMIERE_ID}/card-v1.svg`,
        `/api/premieres/${PREMIERE_ID}/bootstrap`,
        `/api/premieres/${PREMIERE_ID}/manifest`,
      ];
      const before = new Map<string, string>();
      for (const route of routes) {
        const response = await fetch(`${baseUrl}${route}`);
        expect(response.status).toBe(200);
        assertNoStore(response);
        expect(response.headers.get("content-security-policy")).toContain(
          "default-src",
        );
        const body = await response.text();
        before.set(route, body);

        const head = await fetch(`${baseUrl}${route}`, { method: "HEAD" });
        expect(head.status).toBe(200);
        assertNoStore(head);
        expect(await head.text()).toBe("");
        expect(Number(head.headers.get("content-length"))).toBe(
          Buffer.byteLength(body),
        );
      }

      const page = before.get(`/premiere/${PREMIERE_ID}`)!;
      expect(page).toContain("Alpha vs Beta — Proxy War Replay Premiere");
      expect(page).toContain(
        `rel="canonical" href="${PUBLIC_ORIGIN}/premiere/${PREMIERE_ID}"`,
      );
      expect(page).toContain(harness.bootstrap.publicationCommitmentHash);
      expect(page).toContain(
        harness.bootstrap.provenance.eligibilityRecordHash,
      );
      const card = before.get(`/premiere/${PREMIERE_ID}/card-v1.svg`)!;
      expect(card).toContain(`data-premiere-id="${PREMIERE_ID}"`);
      expect(card).toContain("Spoiler-neutral match preview");
      expect(card).toContain("Map: Asia");
      expect(card).toContain("Format: Two-seat FFA");
      expect(card).toContain("Participating agents: Alpha · Beta");
      expect(card).toContain(
        "Alpha: alpha-policy 1.0.0 · Beta: beta-policy 1.0.0",
      );
      expect(card).toContain(harness.bootstrap.publicationCommitmentHash);
      expect(card).not.toContain("authoritativeResult");
      assertExactPublicProvenance(page, card, harness.bootstrap);

      harness.setLifecycle("revealed");
      harness.failOnRevealRead();
      for (const route of [
        `/premiere/${PREMIERE_ID}`,
        `/premiere/${PREMIERE_ID}/card-v1.svg`,
      ]) {
        const response = await fetch(`${baseUrl}${route}`);
        expect(response.status).toBe(200);
        const after = await response.text();
        expect(
          route.startsWith("/premiere/") && !route.endsWith(".svg")
            ? normalizeScriptNonce(after)
            : after,
        ).toBe(
          route.startsWith("/premiere/") && !route.endsWith(".svg")
            ? normalizeScriptNonce(before.get(route)!)
            : before.get(route),
        );
      }
      expect(harness.revealReads()).toBe(0);
    });
  });

  test("binds every inline app-shell script to a fresh CSP nonce", async () => {
    const harness = await createHarness(root);
    await harness.run(async (baseUrl) => {
      const first = await fetch(`${baseUrl}/premiere/${PREMIERE_ID}`);
      const firstBody = await first.text();
      const firstNonce = scriptNonceFromResponse(first);
      const firstScripts = startTags(firstBody, "script");
      const inlineScripts = firstScripts.filter(
        (tag) => !hasTagAttribute(tag, "src"),
      );
      const externalScripts = firstScripts.filter((tag) =>
        hasTagAttribute(tag, "src"),
      );

      expect(inlineScripts.length).toBeGreaterThan(0);
      expect(
        inlineScripts.every((tag) => tagAttribute(tag, "nonce") === firstNonce),
      ).toBe(true);
      expect(externalScripts.length).toBeGreaterThan(0);
      expect(
        externalScripts.every((tag) => tagAttribute(tag, "nonce") === null),
      ).toBe(true);

      const scriptDirective = first.headers
        .get("content-security-policy")!
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("script-src "))!;
      expect(scriptDirective).toBe(`script-src 'self' 'nonce-${firstNonce}'`);
      expect(scriptDirective).not.toContain("'unsafe-inline'");
      expect(scriptDirective).not.toContain("'unsafe-eval'");

      const second = await fetch(`${baseUrl}/premiere/${PREMIERE_ID}`);
      const secondBody = await second.text();
      const secondNonce = scriptNonceFromResponse(second);
      expect(secondNonce).not.toBe(firstNonce);
      expect(normalizeScriptNonce(secondBody)).toBe(
        normalizeScriptNonce(firstBody),
      );
    });
  });

  test("rejects missing or unsafe script CSP directives at startup", () => {
    const registry = {
      get: () => null,
    } as unknown as ReplayPremiereHttpRegistry;
    const create = (pageContentSecurityPolicy: string) =>
      createReplayPremierePublicPageRouter({
        registry,
        loadAppShell: async () => "<html><head></head><body></body></html>",
        publicOrigin: PUBLIC_ORIGIN,
        pageContentSecurityPolicy,
      });

    expect(() => create("default-src 'self'")).toThrow(/requires script-src/);
    expect(() =>
      create("default-src 'self'; script-src 'self' 'unsafe-inline'"),
    ).toThrow(/unsafe script source/);
    expect(() =>
      create("default-src 'self'; script-src 'self' 'unsafe-eval'"),
    ).toThrow(/unsafe script source/);
    expect(() =>
      create("default-src 'self'; script-src 'self' 'nonce-stale'"),
    ).toThrow(/unsafe script source/);
    expect(() => create("script-src 'self'; SCRIPT-SRC 'self'")).toThrow(
      /malformed/,
    );
    expect(() => create(`${PAGE_CSP}\nconnect-src 'self'`)).toThrow(
      /control character/,
    );
  });

  test("rejects preset or invalid nonces and never nonces src scripts", async () => {
    const { gate } = await verifiedPublicationFixture(root);
    const bootstrap = createPremierePublicBootstrap({ gate });
    const render = (appShell: string, scriptNonce = TEST_SCRIPT_NONCE) =>
      renderReplayPremierePageHtml({
        appShell,
        bootstrap,
        publicOrigin: PUBLIC_ORIGIN,
        scriptNonce,
      });

    const page = render(
      "<html><head><script src></script><script>window.BOOTSTRAP_CONFIG={}</script></head><body></body></html>",
    );
    const scripts = startTags(page, "script");
    expect(scripts[0]).toBe("<script src>");
    expect(tagAttribute(scripts[0], "nonce")).toBeNull();
    expect(tagAttribute(scripts[1], "nonce")).toBe(TEST_SCRIPT_NONCE);
    expect(() =>
      render(
        '<html><head><script nonce="preset">window.BOOTSTRAP_CONFIG={}</script></head><body></body></html>',
      ),
    ).toThrow(/preset nonce/);
    expect(() =>
      render(
        "<html><head><script>window.BOOTSTRAP_CONFIG={}</script></head><body></body></html>",
        "not-a-valid-nonce",
      ),
    ).toThrow(/nonce is invalid/);
    expect(() =>
      render(
        '<html><head><script src="/assets/app.js"></script></head><body></body></html>',
      ),
    ).toThrow(/no inline bootstrap script/);
  });

  test("replaces every social tag in the actual production app shell exactly once", async () => {
    const { gate } = await verifiedPublicationFixture(root);
    const bootstrap = createPremierePublicBootstrap({ gate });
    const productionShell = await fs.readFile(
      await resolveAppShellPath(),
      "utf8",
    );
    const page = renderReplayPremierePageHtml({
      appShell: productionShell,
      bootstrap,
      publicOrigin: PUBLIC_ORIGIN,
      scriptNonce: TEST_SCRIPT_NONCE,
    });
    const card = renderReplayPremiereCardSvg(bootstrap);
    const canonicalUrl = `${PUBLIC_ORIGIN}/premiere/${PREMIERE_ID}`;
    const cardUrl = `${canonicalUrl}/card-v1.svg`;

    expect(startTags(page, "title")).toHaveLength(1);
    expect(page.match(/<\/title>/gi)).toHaveLength(1);
    expect(tagsWithAttribute(page, "link", "rel", "canonical")).toHaveLength(1);
    expect(
      tagAttribute(
        tagsWithAttribute(page, "link", "rel", "canonical")[0],
        "href",
      ),
    ).toBe(canonicalUrl);

    const uniqueMetadata = [
      ["name", "description"],
      ["property", "og:type"],
      ["property", "og:title"],
      ["property", "og:description"],
      ["property", "og:url"],
      ["property", "og:image"],
      ["name", "twitter:card"],
      ["name", "twitter:title"],
      ["name", "twitter:description"],
      ["name", "twitter:image"],
    ] as const;
    for (const [attribute, identity] of uniqueMetadata) {
      expect(
        tagsWithAttribute(page, "meta", attribute, identity),
        `${attribute}=${identity}`,
      ).toHaveLength(1);
    }
    expect(metaContent(page, "property", "og:type")).toBe("website");
    expect(metaContent(page, "property", "og:url")).toBe(canonicalUrl);
    expect(metaContent(page, "property", "og:image")).toBe(cardUrl);
    expect(metaContent(page, "name", "twitter:card")).toBe(
      "summary_large_image",
    );
    expect(metaContent(page, "name", "twitter:image")).toBe(cardUrl);
    expect(page).not.toContain("Proxy War - Battle Royale");
    const scripts = startTags(page, "script");
    expect(
      scripts
        .filter((tag) => !hasTagAttribute(tag, "src"))
        .every((tag) => tagAttribute(tag, "nonce") === TEST_SCRIPT_NONCE),
    ).toBe(true);
    expect(
      scripts
        .filter((tag) => hasTagAttribute(tag, "src"))
        .every((tag) => tagAttribute(tag, "nonce") === null),
    ).toBe(true);
    assertExactPublicProvenance(page, card, bootstrap);
  });

  test("carries exact Coworld identifiers when the source is Coworld-rated", async () => {
    const { gate } = await verifiedPublicationFixture(root);
    const bootstrap = structuredClone(createPremierePublicBootstrap({ gate }));
    const coworld = {
      episodeId: "episode-coworld-001",
      leagueId: "league-softmax-001",
      divisionId: "division-proxywar-001",
      roundId: "round-042",
    };
    bootstrap.provenance.sourceKind = "rated_coworld";
    bootstrap.provenance.coworld = coworld;
    bootstrap.publicDefinition.provenance.sourceKind = "rated_coworld";
    bootstrap.publicDefinition.provenance.coworld = { ...coworld };

    const page = renderReplayPremierePageHtml({
      appShell:
        "<!doctype html><html><head><script>window.BOOTSTRAP_CONFIG={}</script></head><body></body></html>",
      bootstrap,
      publicOrigin: PUBLIC_ORIGIN,
      scriptNonce: TEST_SCRIPT_NONCE,
    });
    const card = renderReplayPremiereCardSvg(bootstrap);
    assertExactPublicProvenance(page, card, bootstrap);
    for (const value of Object.values(coworld)) {
      expect(page).toContain(value);
      expect(card).toContain(value);
    }
  });

  test("fails closed on Range, methods, unknown ids, and unreleased chunk/reveal probes", async () => {
    const harness = await createHarness(root);
    await harness.run(async (baseUrl) => {
      for (const route of [
        `/premiere/${PREMIERE_ID}`,
        `/premiere/${PREMIERE_ID}/card-v1.svg`,
        `/api/premieres/${PREMIERE_ID}/bootstrap`,
        `/api/premieres/${PREMIERE_ID}/manifest`,
      ]) {
        const response = await fetch(`${baseUrl}${route}`, {
          headers: { Range: "bytes=0-10" },
        });
        expect(response.status).toBe(416);
        assertNoStore(response);
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_INVALID_REQUEST" },
        });
      }

      for (const route of [
        `/premiere/${PREMIERE_ID}`,
        `/premiere/${PREMIERE_ID}/card-v1.svg`,
        `/api/premieres/${PREMIERE_ID}/bootstrap`,
      ]) {
        const response = await fetch(`${baseUrl}${route}`, { method: "PUT" });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, HEAD");
      }

      const unavailableBodies: string[] = [];
      for (const route of [
        `/api/premieres/${PREMIERE_ID}/chunks/2`,
        `/api/premieres/${PREMIERE_ID}/reveal`,
      ]) {
        const response = await fetch(`${baseUrl}${route}`);
        expect(response.status).toBe(404);
        assertNoStore(response);
        unavailableBodies.push(await response.text());
      }
      expect(new Set(unavailableBodies).size).toBe(1);
      expect(JSON.parse(unavailableBodies[0])).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });

      const unknown = "prem_ffffffffffffffff";
      for (const route of [
        `/premiere/${unknown}`,
        `/premiere/${unknown}/card-v1.svg`,
        `/api/premieres/${unknown}/bootstrap`,
      ]) {
        const response = await fetch(`${baseUrl}${route}`);
        expect(response.status).toBe(404);
        assertNoStore(response);
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_UNAVAILABLE" },
        });
      }
    });
  });

  test("serves the themed app shell (never raw JSON) to a real browser navigating to an unavailable premiere, while API clients keep the JSON contract", async () => {
    const harness = await createHarness(root);
    await harness.run(async (baseUrl) => {
      const unknown = "prem_ffffffffffffffff";
      const browserAccept =
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

      // Real browser navigation to `/premiere/<id>` must never render the raw
      // {"error":{"code":"..."}} body — the P0
      // fix for QA screenshot pass-4/m-20 (Chrome's own JSON viewer, zero
      // site chrome, for a plain page load).
      for (const route of [`/premiere/${unknown}`]) {
        const response = await fetch(`${baseUrl}${route}`, {
          headers: { Accept: browserAccept },
        });
        expect(response.status).toBe(404);
        assertNoStore(response);
        expect(response.headers.get("content-type")).toContain("text/html");
        const body = await response.text();
        expect(body).not.toContain("PREMIERE_UNAVAILABLE");
        expect(body.toLowerCase()).toContain("<!doctype html>");
        // Same CSP-nonce discipline as an ordinary premiere page — no
        // unsafe-inline/unsafe-eval hole opened for this branch.
        const policy = response.headers.get("content-security-policy");
        expect(policy).toContain("script-src 'self' 'nonce-");
      }

      // A bare/wildcard Accept (curl, plain `fetch()`, health checks, any
      // non-browser API client) is NOT a browser navigation and must keep
      // the exact pre-existing JSON contract, including with an explicit
      // `Accept: application/json`.
      for (const accept of [undefined, "application/json"]) {
        const response = await fetch(`${baseUrl}/premiere/${unknown}`, {
          headers: accept === undefined ? {} : { Accept: accept },
        });
        expect(response.status).toBe(404);
        assertNoStore(response);
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_UNAVAILABLE" },
        });
      }

      // Card (SVG social-card embed) requests are never a top-level
      // browser document — the JSON contract stays even with a browser
      // Accept header.
      const cardResponse = await fetch(
        `${baseUrl}/premiere/${unknown}/card-v1.svg`,
        { headers: { Accept: browserAccept } },
      );
      expect(cardResponse.status).toBe(404);
      expect(await cardResponse.json()).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });
    });
  });

  test("escapes metadata and SVG fields without creating executable markup", async () => {
    const harness = await createHarness(root);
    const bootstrap = structuredClone(harness.bootstrap);
    bootstrap.publicDefinition.title = `Alpha </title><script>alert(1)</script>`;
    bootstrap.publicDefinition.spoilerNeutralDescription = `A & B <img src=x onerror=alert(1)>`;
    const page = renderReplayPremierePageHtml({
      appShell:
        "<!doctype html><html><head><title>Old</title><script>window.BOOTSTRAP_CONFIG={}</script></head><body></body></html>",
      bootstrap,
      publicOrigin: PUBLIC_ORIGIN,
      scriptNonce: TEST_SCRIPT_NONCE,
    });
    const card = renderReplayPremiereCardSvg(bootstrap);
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(card).not.toContain("<img src=x");
    expect(card).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  async function createHarness(testRoot: string) {
    const { gate } = await verifiedPublicationFixture(testRoot);
    const bootstrap = createPremierePublicBootstrap({ gate });
    let lifecycle: PremiereState = "playing";
    let revealReads = 0;
    let rejectRevealRead = false;
    const manifest: PremierePreRevealManifestResponse = {
      schemaVersion: 1,
      premiereId: PREMIERE_ID,
      state: "playing",
      serverNow: NOW.toISOString(),
      scheduledAt: bootstrap.publicDefinition.scheduledAt,
      actualStartAt: NOW.toISOString(),
      playbackRate: bootstrap.publicDefinition.playbackRate,
      authoritativeElapsedMs: 0,
      accumulatedPauseMs: 0,
      releasedThroughSequence: -1,
      lastReleasedChunkIndex: -1,
      activeCheckpoint: null,
      provenance: bootstrap.provenance,
      releasedChunks: [],
    };
    const runtime: ReplayPremiereHttpTarget["runtime"] = {
      premiereId: PREMIERE_ID,
      readLifecycleState: () => lifecycle,
      readBootstrap: () => bootstrap,
      readManifest: async () =>
        ({
          ...manifest,
          state: lifecycle === "revealed" ? "playing" : lifecycle,
        }) as PremierePreRevealManifestResponse,
      readChunk: () => null,
      readReveal: () => {
        revealReads += 1;
        if (rejectRevealRead) throw new Error("outcome access forbidden");
        return null;
      },
      readReleasedContext: () => null,
      readLiveVisibleSequence: () => -1,
      readLiveProjection: () => [],
    };
    const target = { runtime } as ReplayPremiereHttpTarget;
    const registry = {
      get: (premiereId: string) => (premiereId === PREMIERE_ID ? target : null),
    } as unknown as ReplayPremiereHttpRegistry;
    const app = express();
    app.use(
      createReplayPremiereRouter({
        registry,
        security: new ReplayPremiereGuestSecurity({
          hmacKey: Buffer.alloc(32, 7),
          expectedOrigin: PUBLIC_ORIGIN,
          production: true,
        }),
      }),
    );
    app.use(
      createReplayPremierePublicPageRouter({
        registry,
        loadAppShell: async () =>
          '<!doctype html><html><head><title>Proxy War</title><script>window.BOOTSTRAP_CONFIG={gameEnv:"dev"}</script><script type="module" src="/assets/app.js"></script></head><body><main id=app></main></body></html>',
        publicOrigin: PUBLIC_ORIGIN,
        pageContentSecurityPolicy: PAGE_CSP,
      }),
    );
    app.use((_request, response) => {
      response.status(404).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
    });
    const server = http.createServer(app);
    return {
      bootstrap,
      setLifecycle(state: PremiereState) {
        lifecycle = state;
      },
      failOnRevealRead() {
        rejectRevealRead = true;
      },
      revealReads: () => revealReads,
      async run(operation: (baseUrl: string) => Promise<void>) {
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        servers.push(server);
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("test server did not bind a TCP address");
        }
        await operation(`http://127.0.0.1:${address.port}`);
      },
    };
  }
});

function assertNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  expect(response.headers.get("surrogate-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("etag")).toBeNull();
}

function scriptNonceFromResponse(response: Response): string {
  const policy = response.headers.get("content-security-policy");
  expect(policy).not.toBeNull();
  const matches = [...policy!.matchAll(/'nonce-([A-Za-z0-9+/]{32})'/g)];
  expect(matches).toHaveLength(1);
  return matches[0][1];
}

function normalizeScriptNonce(markup: string): string {
  return markup.replace(
    /\snonce="[A-Za-z0-9+/]{32}"/g,
    ' nonce="<request-nonce>"',
  );
}

function assertExactPublicProvenance(
  page: string,
  card: string,
  bootstrap: PremierePublicBootstrapResponse,
): void {
  const provenance = bootstrap.provenance;
  expect(metaContent(page, "name", "proxywar:premiere_id")).toBe(
    bootstrap.premiereId,
  );
  expect(metaContent(page, "name", "proxywar:publication_commitment")).toBe(
    bootstrap.publicationCommitmentHash,
  );
  expect(metaContent(page, "name", "proxywar:eligibility_record")).toBe(
    provenance.eligibilityRecordHash,
  );
  expect(metaContent(page, "name", "proxywar:source_kind")).toBe(
    provenance.sourceKind,
  );
  expect(metaContent(page, "name", "proxywar:source_run_id")).toBe(
    provenance.sourceRunId,
  );
  expect(metaContent(page, "name", "proxywar:source_replay_sha256")).toBe(
    provenance.sourceReplaySha256,
  );
  expect(metaContent(page, "name", "proxywar:public_label")).toBe(
    provenance.publicLabel,
  );

  for (const [index, seat] of provenance.seats.entries()) {
    const prefix = `proxywar:seat:${index}`;
    expect(metaContent(page, "name", `${prefix}:id`)).toBe(seat.seatId);
    expect(metaContent(page, "name", `${prefix}:display_name`)).toBe(
      seat.displayName,
    );
    expect(metaContent(page, "name", `${prefix}:policy_namespace`)).toBe(
      seat.policyIdentity.namespace,
    );
    if (seat.policyIdentity.namespace === "softmax_policy_version") {
      expect(metaContent(page, "name", `${prefix}:policy_version_id`)).toBe(
        seat.policyIdentity.policyVersionId,
      );
      expect(metaContent(page, "name", `${prefix}:policy_name`)).toBe(
        seat.policyIdentity.policyName,
      );
      expect(
        metaContent(page, "name", `${prefix}:server_assigned_version`),
      ).toBe(seat.policyIdentity.serverAssignedVersion);
    } else {
      expect(metaContent(page, "name", `${prefix}:manifest_name`)).toBe(
        seat.policyIdentity.manifestName,
      );
      expect(metaContent(page, "name", `${prefix}:declared_version`)).toBe(
        seat.policyIdentity.declaredVersion,
      );
      expect(metaContent(page, "name", `${prefix}:manifest_sha256`)).toBe(
        seat.policyIdentity.manifestSha256,
      );
      expect(metaContent(page, "name", `${prefix}:content_sha256`)).toBe(
        seat.policyIdentity.contentSha256,
      );
    }
  }

  const coworld = provenance.coworld;
  if (coworld !== null) {
    expect(metaContent(page, "name", "proxywar:coworld:episode_id")).toBe(
      coworld.episodeId,
    );
    expect(metaContent(page, "name", "proxywar:coworld:league_id")).toBe(
      coworld.leagueId,
    );
    expect(metaContent(page, "name", "proxywar:coworld:division_id")).toBe(
      coworld.divisionId,
    );
    expect(metaContent(page, "name", "proxywar:coworld:round_id")).toBe(
      coworld.roundId,
    );
  }

  expect(card).toContain(
    `data-publication-commitment="${bootstrap.publicationCommitmentHash}"`,
  );
  expect(card).toContain(
    `data-eligibility-record="${provenance.eligibilityRecordHash}"`,
  );
  expect(card).toContain(`data-source-kind="${provenance.sourceKind}"`);
  expect(card).toContain(`data-source-run-id="${provenance.sourceRunId}"`);
  expect(card).toContain(
    `data-source-replay-sha256="${provenance.sourceReplaySha256}"`,
  );
  expect(card).toContain(
    `data-seat-ids="${escapeAttribute(JSON.stringify(provenance.seats.map((seat) => seat.seatId)))}"`,
  );
  expect(card).toContain(
    `data-policy-identities="${escapeAttribute(
      JSON.stringify(
        provenance.seats.map((seat) => ({
          seatId: seat.seatId,
          displayName: seat.displayName,
          policyIdentity: seat.policyIdentity,
        })),
      ),
    )}"`,
  );
  expect(card).toContain(
    `data-coworld="${escapeAttribute(
      provenance.coworld === null ? "null" : JSON.stringify(provenance.coworld),
    )}"`,
  );

  const attribution =
    "Game art from OpenFront (openfront.io), CC BY-SA 4.0; footage shared under the same license.";
  const noEndorsement =
    "Proxy War is an independent fork — not affiliated with or endorsed by OpenFront.";
  expect(metaContent(page, "name", "proxywar:asset_attribution")).toBe(
    attribution,
  );
  expect(metaContent(page, "name", "proxywar:no_endorsement")).toBe(
    noEndorsement,
  );
  expect(card).toContain(attribution);
  expect(card).toContain(noEndorsement);
}

function startTags(markup: string, tagName: string): string[] {
  return [...markup.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi"))].map(
    (match) => match[0],
  );
}

function tagsWithAttribute(
  markup: string,
  tagName: string,
  attributeName: string,
  expectedValue: string,
): string[] {
  return startTags(markup, tagName).filter((tag) => {
    const actual = tagAttribute(tag, attributeName);
    if (attributeName.toLocaleLowerCase("en-US") === "rel") {
      return (
        actual
          ?.toLocaleLowerCase("en-US")
          .split(/\s+/)
          .includes(expectedValue.toLocaleLowerCase("en-US")) === true
      );
    }
    return (
      actual?.toLocaleLowerCase("en-US") ===
      expectedValue.toLocaleLowerCase("en-US")
    );
  });
}

function metaContent(
  markup: string,
  identityAttribute: "name" | "property",
  identity: string,
): string | null {
  const tags = tagsWithAttribute(markup, "meta", identityAttribute, identity);
  expect(tags, `${identityAttribute}=${identity}`).toHaveLength(1);
  return tagAttribute(tags[0], "content");
}

function tagAttribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function hasTagAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(?:\\s*=|\\s|/?>)`, "i").test(tag);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
