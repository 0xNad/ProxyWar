import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostController,
  restartBeta,
  terminateOwnedGroup,
  validateDirectServer,
  validateOwnedGroup,
} from "./proxywar-beta-launchd-restart.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uid = process.getuid?.() ?? os.userInfo().uid;
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
  const [wrapper, plist] = await Promise.all([
    fs.readFile(path.join(here, "start-proxywar-beta.zsh"), "utf8"),
    fs.readFile(path.join(here, "com.proxywar.beta.plist.example"), "utf8"),
  ]);
  assert.doesNotMatch(wrapper, /npm run agent:closed-beta:prod/);
  assert.match(
    wrapper,
    /"\$NODE_BIN" --import tsx src\/scripts\/ai-agent-demo-server\.ts/,
  );
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>10<\/integer>/);
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
      startTimeoutMs: 35,
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
      startTimeoutMs: 35,
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
    writerReads: 0,
    readyReads: 0,
    preflightReads: 0,
  };
  state.host = {
    async readPlist() {
      return fixture.config;
    },
    async readManaged() {
      if (phase === "current") return current;
      replacementReads += 1;
      if (options.reusePidDuringStability && replacementReads % 2 === 0) {
        return reused;
      }
      return replacement;
    },
    async readWriterPid() {
      state.writerReads += 1;
      if (phase === "current") return options.initialWriterPid ?? current.pid;
      if (transientWriterFailures-- > 0) throw new Error("writer lock absent");
      return replacement.pid;
    },
    async snapshotGroup() {
      return groupAlive ? current.members : [];
    },
    async groupExists() {
      return groupAlive;
    },
    async groupGone() {
      return !groupAlive;
    },
    async signalGroup(pgid, signal) {
      state.signals.push([pgid, signal]);
      groupAlive = false;
      phase = "replacement";
    },
    async ready() {
      if (phase === "current") {
        state.preflightReads += 1;
        return options.currentUnready !== true;
      }
      state.readyReads += 1;
      if (options.neverReady) return false;
      if (transientReadyFailures-- > 0) return false;
      if (options.readinessChanges && state.readyReads % 2 === 0) return false;
      return true;
    },
    async sleep(ms) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)));
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
