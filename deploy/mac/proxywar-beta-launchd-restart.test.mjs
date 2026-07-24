import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostController,
  parseRestartCliArguments,
  PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
  PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS,
  PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
  PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
  PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_TOTAL_MS,
  PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS,
  restartBeta,
  terminateOwnedGroup,
  validateDirectServer,
  validateOwnedGroup,
} from "./proxywar-beta-launchd-restart.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uid = process.getuid?.() ?? os.userInfo().uid;
const DRILL_READY_URL =
  "http://127.0.0.1:8787/api/premieres/prem_0123456789abcdef/manifest";
const temporaryRoots = [];
const liveGroups = new Set();

afterEach(async () => {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  liveGroups.clear();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("wrapper and plist encode direct ownership and bounded group cleanup", async () => {
  const [wrapper, plist, demoServer, startup] = await Promise.all([
    fs.readFile(path.join(here, "start-proxywar-beta.zsh"), "utf8"),
    fs.readFile(path.join(here, "com.proxywar.beta.plist.example"), "utf8"),
    fs.readFile(
      path.join(here, "../../src/scripts/ai-agent-demo-server.ts"),
      "utf8",
    ),
    fs.readFile(
      path.join(
        here,
        "../../src/server/replay-premiere/ReplayPremiereStartup.ts",
      ),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(wrapper, /npm run agent:closed-beta:prod/);
  assert.match(
    wrapper,
    /"\$NODE_BIN" --import tsx src\/scripts\/ai-agent-demo-server\.ts/,
  );
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>10<\/integer>/);
  assert.match(
    startup,
    /REPLAY_PREMIERE_CONTROLLED_OUTAGE_DRILL_HOLD_MS = 46_000/,
  );
  assert.match(
    demoServer,
    /CONTROLLED_OUTAGE_DRILL_SHUTDOWN_WATCHDOG_MS = 50_000/,
  );
  assert.ok(
    46_000 < PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS &&
      PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS <=
        PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS &&
      PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS < 50_000 &&
      50_000 < PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_TOTAL_MS,
  );
});

test("direct server validation rejects the npm ancestor", () => {
  assert.throws(
    () =>
      validateDirectServer(
        managed(100, "/tmp/project", "npm run agent:closed-beta:prod"),
      ),
    /not directly supervising/,
  );
  assert.doesNotThrow(() => validateDirectServer(managed(101, "/tmp/project")));
});

test("ownership audit rejects foreign executable, cwd, and ancestry", () => {
  const foreignExecutable = managed(200, "/tmp/project");
  foreignExecutable.members.push(
    member(201, 200, 200, "/tmp/project", "python3"),
  );
  assert.throws(() => validateOwnedGroup(foreignExecutable), /foreign member/);

  const foreignCwd = managed(210, "/tmp/project");
  foreignCwd.members.push(member(211, 210, 210, "/private/tmp", "node"));
  assert.throws(() => validateOwnedGroup(foreignCwd), /foreign cwd/);

  const foreignParent = managed(220, "/tmp/project");
  foreignParent.members.push(member(221, 999, 220, "/tmp/project", "node"));
  assert.throws(() => validateOwnedGroup(foreignParent), /non-descendant/);
});

test("snapshot skips a confirmed non-root zombie without reading its cwd", async () => {
  const project = "/tmp/project";
  const state = snapshotFixture({
    tables: [
      [
        processRow(230, 1, 230, { cwd: project }),
        processRow(231, 230, 230, { stat: "Z+", cwd: null }),
      ],
    ],
  });
  const members = await state.host.snapshotGroup(230);
  assert.deepEqual(
    members.map(({ pid }) => pid),
    [230],
  );
  assert.deepEqual(state.cwdReads, [230]);
});

test("snapshot tolerates a same-identity live-to-zombie cwd race", async () => {
  const project = "/tmp/project";
  const root = processRow(240, 1, 240, { cwd: project });
  const child = processRow(241, 240, 240, {
    cwd: lsofFailure(),
  });
  const state = snapshotFixture({
    tables: [
      [root, child],
      [root, { ...child, stat: "Z" }],
    ],
  });
  const members = await state.host.snapshotGroup(240);
  assert.deepEqual(
    members.map(({ pid }) => pid),
    [240],
  );
  assert.deepEqual(state.cwdReads, [240, 241, 240]);
  assert.equal(state.tableReads, 2);
});

test("snapshot tolerates a member reaped during cwd lookup", async () => {
  const project = "/tmp/project";
  const root = processRow(250, 1, 250, { cwd: project });
  const child = processRow(251, 250, 250, {
    cwd: lsofFailure(),
  });
  const state = snapshotFixture({ tables: [[root, child], [root]] });
  const members = await state.host.snapshotGroup(250);
  assert.deepEqual(
    members.map(({ pid }) => pid),
    [250],
  );
  assert.equal(state.tableReads, 2);
});

test("snapshot rejects PID reuse and process-group changes after cwd failure", async (t) => {
  const project = "/tmp/project";
  const root = processRow(260, 1, 260, { cwd: project });
  const child = processRow(261, 260, 260, {
    cwd: lsofFailure(),
  });

  await t.test("PID reuse", async () => {
    const reused = { ...child, start: "Wed Jul 22 13:00:01 2026" };
    const state = snapshotFixture({
      tables: [
        [root, child],
        [root, reused],
      ],
    });
    await assert.rejects(
      state.host.snapshotGroup(260),
      /process 261 was reused during cwd lookup/,
    );
  });

  await t.test("process-group change", async () => {
    const moved = { ...child, pgid: 999, stat: "Z" };
    const state = snapshotFixture({
      tables: [
        [root, child],
        [root, moved],
      ],
    });
    await assert.rejects(
      state.host.snapshotGroup(260),
      /process 261 changed process group during cwd lookup/,
    );
  });
});

test("snapshot fails closed when a cwd-unreadable member remains live", async () => {
  const project = "/tmp/project";
  const root = processRow(270, 1, 270, { cwd: project });
  const child = processRow(271, 270, 270, {
    cwd: lsofFailure(),
  });
  const state = snapshotFixture({
    tables: [
      [root, child],
      [root, child],
    ],
  });
  await assert.rejects(
    state.host.snapshotGroup(270),
    /cwd unreadable for live process 271/,
  );
  assert.equal(state.tableReads, 2);
});

test("snapshot never omits a zombie or cwd-unreadable managed leader", async (t) => {
  await t.test("initial zombie", async () => {
    const root = processRow(280, 1, 280, {
      stat: "Z",
      cwd: null,
    });
    const state = snapshotFixture({ tables: [[root]] });
    await assert.rejects(
      state.host.snapshotGroup(280),
      /managed PID 280 is a zombie/,
    );
    assert.deepEqual(state.cwdReads, []);
  });

  await t.test("live-to-zombie cwd race", async () => {
    const root = processRow(281, 1, 281, { cwd: lsofFailure() });
    const state = snapshotFixture({
      tables: [[root], [{ ...root, stat: "Z" }]],
    });
    await assert.rejects(
      state.host.snapshotGroup(281),
      /managed PID 281 is a zombie/,
    );
  });

  await t.test("disappearance before a pre-TERM signal", async () => {
    const captured = managed(282, "/tmp/project");
    const root = processRow(282, 1, 282, { cwd: lsofFailure() });
    const state = snapshotFixture({ tables: [[root], []] });
    const signals = [];
    await assert.rejects(
      terminateOwnedGroup(
        {
          async groupExists() {
            return true;
          },
          async snapshotGroup(...args) {
            return state.host.snapshotGroup(...args);
          },
          async signalGroup(...args) {
            signals.push(args);
          },
        },
        captured,
        { graceMs: 10, forceWaitMs: 10 },
      ),
      /managed PID 282 disappeared during snapshot/,
    );
    assert.deepEqual(signals, []);
  });

  await t.test("another member cannot hide leader disappearance", async () => {
    const project = "/tmp/project";
    const captured = managed(283, project);
    const root = processRow(283, 1, 283, { cwd: project });
    const child = processRow(284, 283, 283, { cwd: lsofFailure() });
    const state = snapshotFixture({
      tables: [[root, child], [{ ...child, stat: "Z" }]],
    });
    const signals = [];
    await assert.rejects(
      terminateOwnedGroup(
        {
          async groupExists() {
            return true;
          },
          async snapshotGroup(...args) {
            return state.host.snapshotGroup(...args);
          },
          async signalGroup(...args) {
            signals.push(args);
          },
        },
        captured,
        { graceMs: 10, forceWaitMs: 10 },
      ),
      /managed PID 283 disappeared during snapshot/,
    );
    assert.deepEqual(signals, []);
  });

  await t.test("initial pre-TERM sample requires the leader", async () => {
    const captured = managed(285, "/tmp/project");
    const state = snapshotFixture({ tables: [[]] });
    const signals = [];
    await assert.rejects(
      terminateOwnedGroup(
        {
          async groupExists() {
            return true;
          },
          async snapshotGroup(...args) {
            return state.host.snapshotGroup(...args);
          },
          async signalGroup(...args) {
            signals.push(args);
          },
        },
        captured,
        { graceMs: 10, forceWaitMs: 10 },
      ),
      /managed PID 285 disappeared during snapshot/,
    );
    assert.deepEqual(signals, []);
  });
});

test("a dying child cannot hide a new live foreign member before TERM", async () => {
  const project = "/tmp/project";
  const captured = managed(290, project);
  const root = processRow(290, 1, 290, { cwd: project });
  const dying = processRow(291, 290, 290, { cwd: lsofFailure() });
  const foreign = processRow(292, 290, 290, {
    cwd: project,
    executable: "python3",
  });
  const state = snapshotFixture({
    tables: [
      [root, dying],
      [root, foreign],
    ],
  });
  const signals = [];
  await assert.rejects(
    terminateOwnedGroup(
      {
        async groupExists() {
          return true;
        },
        async snapshotGroup(...args) {
          return state.host.snapshotGroup(...args);
        },
        async signalGroup(...args) {
          signals.push(args);
        },
      },
      captured,
      { graceMs: 10, forceWaitMs: 10 },
    ),
    /PGID membership changed before signal/,
  );
  assert.deepEqual(signals, []);
  assert.deepEqual(state.cwdReads, [290, 291, 290, 292]);
});

test("post-TERM cleanup audits a captured child after the leader disappears", async () => {
  const project = "/tmp/project";
  const root = processRow(293, 1, 293, { cwd: lsofFailure() });
  const child = processRow(294, 293, 293, { cwd: project });
  const reparentedChild = { ...child, ppid: 1 };
  const capturedRoot = { ...root, cwd: project };
  const captured = {
    ...capturedRoot,
    command: "fixture",
    members: [capturedRoot, child],
  };
  const state = snapshotFixture({
    tables: [[root, child], [reparentedChild]],
  });
  const signals = [];
  let snapshotReads = 0;
  let gone = false;
  const result = await terminateOwnedGroup(
    {
      async groupExists() {
        return true;
      },
      async snapshotGroup(...args) {
        snapshotReads += 1;
        if (snapshotReads === 1) return captured.members;
        return state.host.snapshotGroup(...args);
      },
      async signalGroup(pgid, signal) {
        signals.push([pgid, signal]);
        if (signal === "SIGKILL") gone = true;
      },
      async groupGone() {
        return gone;
      },
      async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
    captured,
    { graceMs: 1, forceWaitMs: 10 },
  );
  assert.deepEqual(result, { forced: true });
  assert.deepEqual(signals, [
    [293, "SIGTERM"],
    [293, "SIGKILL"],
  ]);
  assert.deepEqual(state.cwdReads, [293, 294]);
});

test("pre-TERM audit rejects reparenting even for a captured child", async () => {
  const project = "/tmp/project";
  const root = processRow(295, 1, 295, { cwd: project });
  const child = processRow(296, 295, 295, { cwd: project });
  const captured = {
    ...root,
    command: "fixture",
    members: [root, child],
  };
  const signals = [];
  await assert.rejects(
    terminateOwnedGroup(
      {
        async groupExists() {
          return true;
        },
        async snapshotGroup() {
          return [root, { ...child, ppid: 1 }];
        },
        async signalGroup(...args) {
          signals.push(args);
        },
      },
      captured,
      { graceMs: 10, forceWaitMs: 10 },
    ),
    /PGID membership changed before signal/,
  );
  assert.deepEqual(signals, []);
});

test("PID/start-token reuse is rejected before TERM", async () => {
  const captured = managed(300, "/tmp/project");
  const reused = { ...captured.members[0], start: "different-start" };
  const signals = [];
  const host = {
    async groupExists() {
      return true;
    },
    async snapshotGroup() {
      return [reused];
    },
    async signalGroup(...args) {
      signals.push(args);
    },
  };
  await assert.rejects(
    terminateOwnedGroup(host, captured, { graceMs: 10, forceWaitMs: 10 }),
    /membership changed/,
  );
  assert.deepEqual(signals, []);
});

test(
  "TERM reaches parent and grandchild without force",
  { skip: process.platform !== "darwin", timeout: 10_000 },
  async () => {
    const fixture = await processTree(false);
    const host = hostController();
    const members = await host.snapshotGroup(fixture.pgid);
    const root = members.find(({ pid }) => pid === fixture.pgid);
    const result = await terminateOwnedGroup(
      host,
      { ...root, command: "fixture", members },
      { graceMs: 2_000, forceWaitMs: 1_000 },
    );
    liveGroups.delete(fixture.pgid);
    assert.deepEqual(result, { forced: false });
    assert.equal(await fs.readFile(fixture.parentMarker, "utf8"), "SIGTERM\n");
    assert.equal(await fs.readFile(fixture.childMarker, "utf8"), "SIGTERM\n");
  },
);

test(
  "unchanged non-cooperative tree reports forced only after SIGKILL",
  { skip: process.platform !== "darwin", timeout: 10_000 },
  async () => {
    const fixture = await processTree(true);
    const host = hostController();
    const members = await host.snapshotGroup(fixture.pgid);
    const root = members.find(({ pid }) => pid === fixture.pgid);
    const result = await terminateOwnedGroup(
      host,
      { ...root, command: "fixture", members },
      { graceMs: 150, forceWaitMs: 2_000 },
    );
    liveGroups.delete(fixture.pgid);
    assert.deepEqual(result, { forced: true });
    assert.equal(await fs.readFile(fixture.parentMarker, "utf8"), "SIGTERM\n");
    assert.equal(await fs.readFile(fixture.childMarker, "utf8"), "SIGTERM\n");
  },
);

test("restart rejects an initial writer mismatch before signalling", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { initialWriterPid: 999 });
  await assert.rejects(
    restartBeta({
      host: state.host,
      domain: "gui/501",
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      startTimeoutMs: 50,
    }),
    /writer lock is not owned/,
  );
  assert.deepEqual(state.signals, []);
});

test("restart refuses before signalling when the current server is unready", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { currentUnready: true });
  await assert.rejects(
    restartBeta({
      host: state.host,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      startTimeoutMs: 50,
    }),
    /current server failed the readiness preflight/,
  );
  assert.deepEqual(state.signals, []);
  assert.equal(state.preflightReads, 1);
});

test("allow-unready-current overrides only the preflight for hang recovery", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { currentUnready: true });
  const result = await restartBeta({
    host: state.host,
    allowUnreadyCurrent: true,
    plistPath: fixture.plistPath,
    writerLockPath: fixture.lockPath,
    graceMs: 50,
    forceWaitMs: 50,
    startTimeoutMs: 500,
  });
  assert.equal(result.currentReady, false);
  assert.equal(result.newPid, 401);
  assert.equal(result.ready, true);
});

test("dry run reports current readiness without signalling", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture);
  const result = await restartBeta({
    host: state.host,
    dryRun: true,
    plistPath: fixture.plistPath,
    writerLockPath: fixture.lockPath,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.currentReady, true);
  const wrapperSha256 = createHash("sha256")
    .update(await fs.readFile(fixture.wrapperPath))
    .digest("hex");
  assert.equal(result.installedWrapperSha256, wrapperSha256);
  assert.deepEqual(state.signals, []);
});

test("restart binds the installed wrapper SHA-256 before signalling", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture);
  const expectedWrapperSha256 = createHash("sha256")
    .update(await fs.readFile(fixture.wrapperPath))
    .digest("hex");
  assert.deepEqual(
    parseRestartCliArguments([
      `--expected-wrapper-sha256=${expectedWrapperSha256}`,
    ]),
    { expectedWrapperSha256 },
  );
  await assert.rejects(
    restartBeta({
      host: state.host,
      dryRun: true,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      expectedWrapperSha256: "0".repeat(64),
    }),
    /installed wrapper SHA-256 does not match reviewed bytes/,
  );
  assert.deepEqual(state.signals, []);
});

test("controlled outage drill CLI selects bounded safe defaults", () => {
  assert.deepEqual(
    parseRestartCliArguments(["--premiere-controlled-outage-drill"]),
    {
      premiereControlledOutageDrill: true,
      graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
      forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
      startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
    },
  );
});

test("controlled outage drill rejects unsafe timing and unready overrides", async (t) => {
  const safe = {
    host: {},
    premiereControlledOutageDrill: true,
    readyUrl: DRILL_READY_URL,
    graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
    forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
    startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
  };
  await t.test("short grace", async () => {
    await assert.rejects(
      restartBeta({
        ...safe,
        graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS - 1,
      }),
      /requires --grace-ms=49000/,
    );
  });
  await t.test("long grace", async () => {
    await assert.rejects(
      restartBeta({
        ...safe,
        graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS + 1,
      }),
      /requires --grace-ms=49000/,
    );
  });
  await t.test("generic league readiness", async () => {
    await assert.rejects(
      restartBeta({
        ...safe,
        readyUrl: "http://127.0.0.1:8787/league",
      }),
      /requires --ready-url for the exact active Premiere manifest/,
    );
  });
  await t.test("long replacement timeout", async () => {
    await assert.rejects(
      restartBeta({
        ...safe,
        startTimeoutMs:
          PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS + 1,
      }),
      /requires --start-timeout-ms<=/,
    );
  });
  await t.test("long force wait", async () => {
    await assert.rejects(
      restartBeta({
        ...safe,
        forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS + 1,
      }),
      /requires --force-wait-ms<=/,
    );
  });
  await t.test("unready override", async () => {
    await assert.rejects(
      restartBeta({ ...safe, allowUnreadyCurrent: true }),
      /requires a ready current server/,
    );
  });
});

test("explicit controlled outage drill signals only the Node leader and never forces a cooperative exit", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture);
  const result = await restartBeta({
    host: state.host,
    premiereControlledOutageDrill: true,
    readyUrl: DRILL_READY_URL,
    plistPath: fixture.plistPath,
    writerLockPath: fixture.lockPath,
    graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
    forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
    startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
  });

  assert.equal(result.mode, "premiere-controlled-outage-drill");
  assert.equal(result.signal, "SIGUSR2");
  assert.equal(result.requiredDwellMs, 46_000);
  assert.equal(result.maximumDwellMs, 49_000);
  assert.equal(result.measuredDwellMs, 46_000);
  assert.equal(result.measuredReplacementMs, 100);
  assert.equal(result.measuredTotalMs, 46_100);
  assert.ok(result.measuredTotalMs < 58_000);
  assert.equal(result.fallbackTerm, false);
  assert.equal(result.forced, false);
  assert.equal(
    result.verificationScope,
    "process_dwell_and_manifest_readiness_only",
  );
  assert.equal(result.ledgerVerificationRequired, true);
  assert.deepEqual(state.processSignals, [[400, "SIGUSR2"]]);
  assert.deepEqual(state.signals, []);
});

test("controlled outage drill refuses an early old-PID exit after accepting the replacement", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { controlledDwellMs: 1_000 });
  await assert.rejects(
    restartBeta({
      host: state.host,
      premiereControlledOutageDrill: true,
      readyUrl: DRILL_READY_URL,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
      forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
      startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
    }),
    /old PID exited outside the required 46000-49000ms dwell window/,
  );
  assert.deepEqual(state.processSignals, [[400, "SIGUSR2"]]);
  assert.deepEqual(state.signals, []);
  assert.ok(state.readyReads >= 2);
});

test("controlled outage drill refuses an old-PID exit at the late dwell boundary", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, {
    controlledDwellMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS,
  });
  await assert.rejects(
    restartBeta({
      host: state.host,
      premiereControlledOutageDrill: true,
      readyUrl: DRILL_READY_URL,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
      forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
      startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
    }),
    /old PID exited outside the required 46000-49000ms dwell window/,
  );
  assert.ok(state.readyReads >= 2);
});

test("controlled outage drill rejects an 8001ms readiness-probe overrun at the absolute replacement deadline", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { replacementReadyDelayMs: 8_001 });
  await assert.rejects(
    restartBeta({
      host: state.host,
      premiereControlledOutageDrill: true,
      readyUrl: DRILL_READY_URL,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
      forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
      startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
    }),
    /replacement acceptance failed: replacement readiness deadline exceeded/,
  );
  assert.equal(state.readyReads, 1);
});

test("controlled outage drill cleans up but refuses success when the leader needs TERM fallback", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { controlledNeverExits: true });
  await assert.rejects(
    restartBeta({
      host: state.host,
      premiereControlledOutageDrill: true,
      readyUrl: DRILL_READY_URL,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
      forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
      startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
    }),
    /required TERM\/KILL fallback/,
  );
  assert.deepEqual(state.processSignals, [[400, "SIGUSR2"]]);
  assert.deepEqual(state.signals, [[400, "SIGTERM"]]);
  assert.ok(state.readyReads >= 2);
});

test("ordinary restart remains SIGTERM-only and reports restart mode", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture);
  const result = await restartBeta({
    host: state.host,
    plistPath: fixture.plistPath,
    writerLockPath: fixture.lockPath,
    graceMs: 50,
    forceWaitMs: 50,
    startTimeoutMs: 500,
  });
  assert.equal(result.mode, "restart");
  assert.equal(result.forced, false);
  assert.deepEqual(state.processSignals, []);
  assert.deepEqual(state.signals, [[400, "SIGTERM"]]);
});

test("controlled outage drill dry run reports mode without signalling", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture);
  const result = await restartBeta({
    host: state.host,
    premiereControlledOutageDrill: true,
    readyUrl: DRILL_READY_URL,
    dryRun: true,
    plistPath: fixture.plistPath,
    writerLockPath: fixture.lockPath,
    graceMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS,
    forceWaitMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS,
    startTimeoutMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS,
  });
  assert.equal(result.mode, "premiere-controlled-outage-drill");
  assert.equal(result.requiredDwellMs, 46_000);
  assert.equal(
    result.verificationScope,
    "process_dwell_and_manifest_readiness_only",
  );
  assert.deepEqual(state.processSignals, []);
  assert.deepEqual(state.signals, []);
});

test("replacement polling tolerates missing writer and not-ready transients", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, {
    transientWriterFailures: 1,
    transientReadyFailures: 1,
  });
  const result = await restartBeta({
    host: state.host,
    domain: "gui/501",
    plistPath: fixture.plistPath,
    writerLockPath: fixture.lockPath,
    graceMs: 50,
    forceWaitMs: 50,
    startTimeoutMs: 500,
  });
  assert.equal(result.newPid, 401);
  assert.equal(result.writerPid, 401);
  assert.equal(result.ready, true);
  assert.equal(result.forced, false);
  assert.ok(state.writerReads >= 3);
  assert.ok(state.readyReads >= 3);
});

test("replacement rejects same-PID reuse during stability sampling", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { reusePidDuringStability: true });
  await assert.rejects(
    restartBeta({
      host: state.host,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: 20,
      forceWaitMs: 20,
      startTimeoutMs: 101,
    }),
    /replacement acceptance failed: replacement process identity changed/,
  );
});

test("replacement requires a second stable HTTP 200", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { readinessChanges: true });
  await assert.rejects(
    restartBeta({
      host: state.host,
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: 20,
      forceWaitMs: 20,
      startTimeoutMs: 101,
    }),
    /replacement acceptance failed: replacement readiness changed/,
  );
});

test("replacement readiness failure is bounded and reported", async () => {
  const fixture = await launchFiles();
  const state = fakeRestart(fixture, { neverReady: true });
  await assert.rejects(
    restartBeta({
      host: state.host,
      domain: "gui/501",
      plistPath: fixture.plistPath,
      writerLockPath: fixture.lockPath,
      graceMs: 20,
      forceWaitMs: 20,
      startTimeoutMs: 30,
    }),
    /replacement acceptance failed: replacement not ready/,
  );
});

function fakeRestart(fixture, options = {}) {
  const current = managed(400, fixture.projectDir);
  const replacement = managed(401, fixture.projectDir);
  let phase = "current";
  let groupAlive = true;
  let virtualNowMs = 0;
  let controlledSignalAt = null;
  let transientWriterFailures = options.transientWriterFailures ?? 0;
  let transientReadyFailures = options.transientReadyFailures ?? 0;
  let replacementReads = 0;
  const reused = {
    ...replacement,
    start: "reused-start-token",
    members: [{ ...replacement.members[0], start: "reused-start-token" }],
  };
  const state = {
    signals: [],
    processSignals: [],
    writerReads: 0,
    readyReads: 0,
    preflightReads: 0,
  };
  const refreshControlledExit = () => {
    if (
      groupAlive &&
      controlledSignalAt !== null &&
      options.controlledNeverExits !== true &&
      virtualNowMs - controlledSignalAt >=
        (options.controlledDwellMs ??
          PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS)
    ) {
      groupAlive = false;
      phase = "replacement";
    }
  };
  state.host = {
    async readPlist() {
      return fixture.config;
    },
    async readManaged() {
      refreshControlledExit();
      if (phase === "current") return current;
      replacementReads += 1;
      if (options.reusePidDuringStability && replacementReads % 2 === 0) {
        return reused;
      }
      return replacement;
    },
    async readWriterPid() {
      refreshControlledExit();
      state.writerReads += 1;
      if (phase === "current") return options.initialWriterPid ?? current.pid;
      if (transientWriterFailures-- > 0) throw new Error("writer lock absent");
      return replacement.pid;
    },
    async snapshotGroup() {
      return groupAlive ? current.members : [];
    },
    async groupExists() {
      refreshControlledExit();
      return groupAlive;
    },
    async groupGone() {
      refreshControlledExit();
      return !groupAlive;
    },
    async signalGroup(pgid, signal) {
      state.signals.push([pgid, signal]);
      groupAlive = false;
      phase = "replacement";
    },
    async signalProcess(pid, signal) {
      state.processSignals.push([pid, signal]);
      controlledSignalAt = virtualNowMs;
    },
    async ready() {
      refreshControlledExit();
      if (phase === "current") {
        state.preflightReads += 1;
        return options.currentUnready !== true;
      }
      state.readyReads += 1;
      if (
        state.readyReads === 1 &&
        options.replacementReadyDelayMs !== undefined
      ) {
        virtualNowMs += options.replacementReadyDelayMs;
      }
      if (options.neverReady) return false;
      if (transientReadyFailures-- > 0) return false;
      if (options.readinessChanges && state.readyReads % 2 === 0) return false;
      return true;
    },
    async sleep(ms) {
      virtualNowMs += ms;
      refreshControlledExit();
    },
    nowMs() {
      return virtualNowMs;
    },
  };
  return state;
}

function member(pid, ppid, pgid, cwd, executable = "node") {
  return { uid, pid, ppid, pgid, cwd, executable, start: `start-${pid}` };
}

function managed(
  pid,
  cwd,
  command = "/opt/node --import tsx src/scripts/ai-agent-demo-server.ts",
) {
  const root = member(pid, 1, pid, cwd);
  return { ...root, command, members: [root] };
}

function processRow(pid, ppid, pgid, options = {}) {
  return {
    uid,
    pid,
    ppid,
    pgid,
    stat: options.stat ?? "S",
    start:
      options.start ??
      `Wed Jul 22 12:${String(pid % 60).padStart(2, "0")}:00 2026`,
    executable: options.executable ?? "node",
    cwd: options.cwd,
  };
}

function snapshotFixture({ tables }) {
  let tableReads = 0;
  const cwdReads = [];
  const exec = async (file, args) => {
    if (file === "/bin/ps" && args[0] === "-axo") {
      const table = tables[Math.min(tableReads, tables.length - 1)];
      tableReads += 1;
      return {
        stdout: `${table
          .map(
            (entry) =>
              `${entry.uid} ${entry.pid} ${entry.ppid} ${entry.pgid} ${entry.stat} ${entry.start} ${entry.executable}`,
          )
          .join("\n")}\n`,
      };
    }
    if (file === "/usr/sbin/lsof") {
      const pid = Number(args[2]);
      cwdReads.push(pid);
      const process = tables
        .flat()
        .find((candidate) => candidate.pid === pid && candidate.cwd !== null);
      const cwd = process?.cwd;
      if (cwd instanceof Error) throw cwd;
      if (typeof cwd !== "string") throw lsofFailure();
      return { stdout: `p${pid}\nfcwd\nn${cwd}\n` };
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  return {
    host: hostController({ exec }),
    cwdReads,
    get tableReads() {
      return tableReads;
    },
  };
}

function lsofFailure() {
  const error = new Error("lsof found no cwd");
  error.code = 1;
  error.stdout = "";
  return error;
}

async function launchFiles() {
  const root = await temporaryRoot();
  const projectDir = path.join(root, "project");
  const wrapperPath = path.join(
    root,
    "Library",
    "Application Support",
    "ProxyWar",
    "bin",
    "start-proxywar-beta.zsh",
  );
  const plistPath = path.join(root, "com.proxywar.beta.plist");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
  await fs.writeFile(
    wrapperPath,
    '#!/bin/zsh\nexec /usr/bin/caffeinate -s "$NODE_BIN" --import tsx src/scripts/ai-agent-demo-server.ts\n',
    { mode: 0o755 },
  );
  await fs.writeFile(plistPath, "fixture\n", { mode: 0o600 });
  return {
    projectDir,
    wrapperPath,
    plistPath,
    lockPath: path.join(root, "write-owner.json"),
    config: {
      Label: "com.proxywar.beta",
      ProgramArguments: ["/bin/zsh", wrapperPath],
      EnvironmentVariables: { PROXYWAR_PROJECT_DIR: projectDir },
      WorkingDirectory: projectDir,
      KeepAlive: true,
      RunAtLoad: true,
      AbandonProcessGroup: false,
      ExitTimeOut: 10,
    },
  };
}

async function processTree(ignoreTerm) {
  const root = await temporaryRoot();
  const files = Object.fromEntries(
    ["pid", "ready", "child-ready", "parent-term", "child-term"].map((name) => [
      name,
      path.join(root, name),
    ]),
  );
  const childSource = String.raw`
    const fs = require("node:fs");
    const [ready, marker, ignore] = process.argv.slice(1);
    fs.writeFileSync(ready, String(process.pid));
    process.on("SIGTERM", () => {
      fs.appendFileSync(marker, "SIGTERM\n");
      if (ignore !== "true") setTimeout(() => process.exit(0), 75);
    });
    setInterval(() => {}, 1000);
  `;
  const parentSource = String.raw`
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [ready, childReady, parentMarker, childMarker, ignore, childSource] = process.argv.slice(1);
    spawn(process.execPath, ["--eval", childSource, childReady, childMarker, ignore], { stdio: "ignore" });
    fs.writeFileSync(ready, String(process.pid));
    process.on("SIGTERM", () => {
      fs.appendFileSync(parentMarker, "SIGTERM\n");
      if (ignore !== "true") setTimeout(() => process.exit(0), 125);
    });
    setInterval(() => {}, 1000);
  `;
  const launcherSource = String.raw`
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const args = process.argv.slice(1);
    const child = spawn(process.execPath, ["--eval", ...args.slice(1)], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(args[0], String(child.pid));
  `;
  const launcher = spawn(
    process.execPath,
    [
      "--eval",
      launcherSource,
      files.pid,
      parentSource,
      files.ready,
      files["child-ready"],
      files["parent-term"],
      files["child-term"],
      String(ignoreTerm),
      childSource,
    ],
    { cwd: root, stdio: "ignore" },
  );
  await once(launcher, "exit");
  await Promise.all(
    [files.pid, files.ready, files["child-ready"]].map(waitForFile),
  );
  const pgid = Number(await fs.readFile(files.pid, "utf8"));
  liveGroups.add(pgid);
  return {
    pgid,
    parentMarker: files["parent-term"],
    childMarker: files["child-term"],
  };
}

async function temporaryRoot() {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-restart-"));
  const root = await fs.realpath(created);
  temporaryRoots.push(root);
  return root;
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
