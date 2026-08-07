/**
 * Pins the server half of the league betting exclusion (operator boundary
 * 2026-07-27: speculation lives only on the separate bet surface, never
 * inside the league): when `PROXYWAR_WAGERING_ENABLED` is unset, the
 * wagering route/interaction surface must not exist.
 *
 * Three layers, matching how the deployments actually run:
 *
 *  1. BEHAVIOR — `ReplayPremiereInteractions` constructed without
 *     `wageringEnabled` (exactly what an unset env produces via
 *     `envFlag()`) exposes no market surface: reads are `null`, trades and
 *     checkpoint-market transitions throw `wagering_disabled`.
 *  2. SOURCE STRUCTURE — `src/scripts/ai-agent-demo-server.ts` (the server
 *     behind beta.proxywar.xyz and bet.proxywar.xyz) derives every
 *     wagering mount from `envFlag("PROXYWAR_WAGERING_ENABLED")`, 404s the
 *     points/account/settlement routes without it, and only mounts the
 *     internal betting-profile route inside the wagering gate. (Booting
 *     that server in a unit test is not practical — same source-pin style
 *     as `AiAgentDemoServerClipCapability.test.ts`.)
 *  3. LEAGUE PACKAGE SERVER — the coworld episode entrypoint
 *     (`coworld-adapter/src/no-docker-coworld-episode.ts`, the process the
 *     league image actually runs) contains no betting/wagering surface at
 *     all. If this pin ever fires, either betting leaked into the league
 *     package server (remove it) or a comment newly mentions
 *     betting (update this pin deliberately, with the boundary in mind).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayPremiereError } from "../../src/server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereInteractions } from "../../src/server/replay-premiere/ReplayPremiereInteractions";

const repoRoot = path.resolve(__dirname, "../..");

const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;

/**
 * Minimal real-interactions harness (same construction the wagering suites
 * use — see `tests/server/replay-premiere/wagering/
 * ReplayPremiereMarketOrders.test.ts`), with `wageringEnabled` deliberately
 * ABSENT: `envFlag("PROXYWAR_WAGERING_ENABLED")` on an unset env yields
 * `false`, and the constructor defaults the omitted option the same way, so
 * this is the league/beta server's exact configuration.
 */
function wageringOffInteractions(): ReplayPremiereInteractions {
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  let randomValue = 1;
  return new ReplayPremiereInteractions({
    premiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 35 },
      { id: "cp_second001", sequence: 65 },
    ],
    seats: [
      {
        seatId: "seat-1",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: "SEAT0001",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "beta",
          declaredVersion: "1",
          manifestSha256: "3".repeat(64),
          contentSha256: "4".repeat(64),
        },
      },
    ],
    getPremiereState: () => "playing",
    getReleasedContext: (sequence) =>
      sequence <= 80
        ? { releasedThroughSequence: 80, turn: sequence, eventContext: null }
        : null,
    getLiveVisibleSequence: () => 80,
    persistence: {
      async persist() {},
    },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => {
      nowMs += 1;
      return new Date(nowMs);
    },
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    admitAnonymousWrite: () => undefined,
  });
}

function expectWageringDisabled(error: unknown): void {
  expect(error).toBeInstanceOf(ReplayPremiereError);
  const premiereError = error as ReplayPremiereError;
  expect(premiereError.operatorCode).toBe("wagering_disabled");
  expect(premiereError.publicCode).toBe("PREMIERE_INVALID_REQUEST");
  expect(premiereError.httpStatus).toBe(400);
}

async function demoServerSource(): Promise<string> {
  return fs.readFile(
    path.join(repoRoot, "src", "scripts", "ai-agent-demo-server.ts"),
    "utf8",
  );
}

describe("league wagering route absence (PROXYWAR_WAGERING_ENABLED unset)", () => {
  it("interactions without wageringEnabled expose no market surface", async () => {
    const interactions = wageringOffInteractions();
    expect(interactions.isWageringEnabled()).toBe(false);
    // Market reads: absent, not empty.
    expect(interactions.readMarketState(null)).toBeNull();
    expect(interactions.readMarketState(guestA)).toBeNull();
    // Trades: rejected before any session/idempotency logic runs.
    await interactions
      .submitMarketOrder({
        participantId: guestA,
        participantKind: "real",
        sessionId: `sess_${"1".repeat(32)}`,
        seatId: "seat-1",
        side: "buy",
        amount: 25,
        limitPrice: 99,
        sequence: 40,
        idempotencyKey: `idem_${"1".repeat(16)}`,
        requesterBucketId: `ip_${"1".repeat(64)}`,
      })
      .then(
        () => {
          throw new Error("submitMarketOrder must reject with wagering off");
        },
        (error: unknown) => expectWageringDisabled(error),
      );
    // Market checkpoint transitions: same closed door.
    try {
      interactions.prepareMarkCheckpointPassed({
        checkpointId: "cp_first0001",
        occurredAt: new Date().toISOString(),
        optionSeatIds: ["seat-1", "SEAT0001"],
      });
      throw new Error(
        "prepareMarkCheckpointPassed must throw with wagering off",
      );
    } catch (error) {
      expectWageringDisabled(error);
    }
  });

  it("demo server derives every wagering mount from the env flag", async () => {
    const source = await demoServerSource();
    // The two wagering signals both come from the SAME unset-means-off
    // env flag — the premiere runtime market...
    expect(source).toContain(
      'wageringEnabled: envFlag("PROXYWAR_WAGERING_ENABLED")',
    );
    // ...and the points/account/settlement route surface.
    expect(source).toContain(
      'const pointsRoutesEnabled = envFlag("PROXYWAR_WAGERING_ENABLED")',
    );
    // envFlag treats an unset env as off (no default-on grammar).
    const envFlagStart = source.indexOf("function envFlag(");
    expect(envFlagStart).toBeGreaterThanOrEqual(0);
    const envFlagBody = source.slice(envFlagStart, envFlagStart + 300);
    expect(envFlagBody).toContain('["1", "true", "yes", "on"].includes');
    expect(envFlagBody).toContain('?? ""');
  });

  it.each([
    "/api/premieres/points/leaderboard",
    "/api/premieres/account",
    "/api/premieres/:id/settlement",
  ])("demo server 404s %s before any handler logic", async (route) => {
    const source = await demoServerSource();
    const mount = source.indexOf(`app.get("${route}", async (req, res) => {`);
    expect(mount).toBeGreaterThanOrEqual(0);
    // The wagering gate is the FIRST thing in the handler: reject window is
    // small and must contain the guard + 404 before the first real work.
    const handlerHead = source.slice(mount, mount + 400);
    expect(handlerHead).toContain("if (!pointsRoutesEnabled) {");
    expect(handlerHead).toContain(
      'res.status(404).json({ error: { code: "PREMIERE_UNAVAILABLE" } })',
    );
    const guardAt = handlerHead.indexOf("if (!pointsRoutesEnabled) {");
    const tryAt = handlerHead.indexOf("try {");
    if (tryAt >= 0) {
      expect(guardAt).toBeLessThan(tryAt);
    }
  });

  it("demo server mounts the internal betting-profile route only inside the wagering gate", async () => {
    const source = await demoServerSource();
    const gate = source.indexOf(
      "if (pointsRoutesEnabled && bettingProfileServiceToken !== null) {",
    );
    const route = source.indexOf(
      '"/api/internal/accounts/:accountId/betting-profile"',
    );
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(route).toBeGreaterThan(gate);
    // Bounded window: the mount sits directly inside that gate, not in some
    // later unconditional block.
    expect(route - gate).toBeLessThan(200);
  });

  it("the coworld league package server has no betting surface at all", async () => {
    const source = await fs.readFile(
      path.join(
        repoRoot,
        "coworld-adapter",
        "src",
        "no-docker-coworld-episode.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/wagering|betting|PROXYWAR_WAGERING/i);
  });
});
