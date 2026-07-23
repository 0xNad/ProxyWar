#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL = "com.proxywar.beta";
const SERVER_ENTRY = "src/scripts/ai-agent-demo-server.ts";
const TARGET = `gui/${process.getuid()}/${LABEL}`;
export const PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS = 46_000;
export const PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS = 49_000;
export const PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS = 49_000;
export const PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS = 8_000;
export const PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS = 500;
export const PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_TOTAL_MS = 58_000;
const PREMIERE_CONTROLLED_OUTAGE_DRILL_SIGNAL = "SIGUSR2";
// prettier-ignore
const DEFAULT_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
// prettier-ignore
const DEFAULT_WRITER_LOCK = path.join(os.homedir(), "Library", "Application Support", "ProxyWar", "storage", "replay-premiere", "event-store-v1", "write-owner.json");
// esbuild is tsx's persistent transform service: on a cold-cache start after a
// source change it appears as a direct child of the server and stays alive.
// Current clip workers are detached process-group leaders, so their Chrome and
// ffmpeg descendants must not normally appear in the beta server PGID. Keep
// their executable names accepted here for restart compatibility with an
// already-running older server; ancestry, cwd, uid, and identity checks still
// have to prove that any such member belongs to the managed group.
// prettier-ignore
const ALLOWED_EXECUTABLES = new Set(["bash", "caffeinate", "claude", "esbuild", "ffmpeg", "node", "npm", "sh", "zsh", "Google Chrome", "Google Chrome He", "Google Chrome Helper"]);

export function validateDirectServer(managed) {
  const command = managed.command?.trim() ?? "";
  if (
    managed.executable !== "node" ||
    !command.includes("--import tsx") ||
    !command.includes(SERVER_ENTRY) ||
    command.includes("npm run") ||
    command.includes("node_modules/.bin/tsx") ||
    command.includes("node_modules/.bin/cross-env")
  ) {
    throw new Error("launchd is not directly supervising the writer server");
  }
}

export function validateOwnedGroup(managed, expectedCwd = managed.cwd) {
  if (managed.pid <= 1 || managed.pid !== managed.pgid || managed.ppid !== 1) {
    throw new Error("managed PID is not a launchd-owned PGID leader");
  }
  const root = path.resolve(expectedCwd);
  const members = managed.members ?? [];
  const byPid = new Map(members.map((member) => [member.pid, member]));
  if (!byPid.has(managed.pid))
    throw new Error("managed PID is absent from PGID");
  for (const member of members) {
    if (
      member.uid !== managed.uid ||
      member.pgid !== managed.pgid ||
      !ALLOWED_EXECUTABLES.has(member.executable)
    ) {
      throw new Error(`foreign member in PGID ${managed.pgid}`);
    }
    const cwd = path.resolve(member.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
      throw new Error(`foreign cwd in PGID ${managed.pgid}`);
    }
    if (member.pid === managed.pid) continue;
    const seen = new Set([member.pid]);
    let cursor = member;
    while (cursor.pid !== managed.pid) {
      const parent = byPid.get(cursor.ppid);
      if (parent === undefined || seen.has(parent.pid)) {
        throw new Error(`non-descendant member in PGID ${managed.pgid}`);
      }
      seen.add(parent.pid);
      cursor = parent;
    }
  }
}

export async function terminateOwnedGroup(
  host,
  managed,
  { graceMs, forceWaitMs },
) {
  validateOwnedGroup(managed);
  if (await host.groupExists(managed.pgid)) {
    assertCapturedMembers(
      managed,
      await host.snapshotGroup(managed.pgid, managed.pid, true),
    );
    await host.signalGroup(managed.pgid, "SIGTERM");
  }
  if (await wait(host, graceMs, () => host.groupGone(managed.pgid))) {
    return { forced: false };
  }
  const remaining = await host.snapshotGroup(managed.pgid, managed.pid, false);
  if (remaining.length === 0) return { forced: false };
  assertCapturedMembers(managed, remaining, { allowPostTermReparent: true });
  await host.signalGroup(managed.pgid, "SIGKILL");
  if (!(await wait(host, forceWaitMs, () => host.groupGone(managed.pgid)))) {
    throw new Error(`PGID ${managed.pgid} survived SIGKILL`);
  }
  return { forced: true };
}

async function runControlledOutageDrill(
  host,
  managed,
  { graceMs, forceWaitMs },
) {
  validateOwnedGroup(managed);
  const signalledAt = hostNowMs(host);
  if (await host.groupExists(managed.pgid)) {
    assertCapturedMembers(
      managed,
      await host.snapshotGroup(managed.pgid, managed.pid, true),
    );
    // SIGUSR2 belongs only to the validated direct Node leader. Sending it to
    // the whole PGID would apply platform-default semantics to caffeinate,
    // esbuild, or other children before the server can stop them with TERM.
    await host.signalProcess(
      managed.pid,
      PREMIERE_CONTROLLED_OUTAGE_DRILL_SIGNAL,
    );
  }
  if (await wait(host, graceMs, () => host.groupGone(managed.pgid))) {
    const dwellMs = Math.max(0, hostNowMs(host) - signalledAt);
    return {
      cooperative:
        dwellMs >= PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS &&
        dwellMs < PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS,
      dwellMs,
      fallbackTerm: false,
      forced: false,
    };
  }

  let remaining = await host.snapshotGroup(managed.pgid, managed.pid, false);
  if (remaining.length === 0) {
    const dwellMs = Math.max(0, hostNowMs(host) - signalledAt);
    return {
      cooperative:
        dwellMs >= PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS &&
        dwellMs < PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS,
      dwellMs,
      fallbackTerm: false,
      forced: false,
    };
  }
  assertCapturedMembers(managed, remaining, { allowPostTermReparent: true });
  await host.signalGroup(managed.pgid, "SIGTERM");
  if (await wait(host, forceWaitMs, () => host.groupGone(managed.pgid))) {
    return {
      cooperative: false,
      dwellMs: Math.max(0, hostNowMs(host) - signalledAt),
      fallbackTerm: true,
      forced: false,
    };
  }
  remaining = await host.snapshotGroup(managed.pgid, managed.pid, false);
  if (remaining.length === 0) {
    return {
      cooperative: false,
      dwellMs: Math.max(0, hostNowMs(host) - signalledAt),
      fallbackTerm: true,
      forced: false,
    };
  }
  assertCapturedMembers(managed, remaining, { allowPostTermReparent: true });
  await host.signalGroup(managed.pgid, "SIGKILL");
  if (!(await wait(host, forceWaitMs, () => host.groupGone(managed.pgid)))) {
    throw new Error(`PGID ${managed.pgid} survived SIGKILL`);
  }
  return {
    cooperative: false,
    dwellMs: Math.max(0, hostNowMs(host) - signalledAt),
    fallbackTerm: true,
    forced: true,
  };
}

export async function restartBeta({
  host,
  plistPath = DEFAULT_PLIST,
  writerLockPath = DEFAULT_WRITER_LOCK,
  readyUrl = "http://127.0.0.1:8787/league",
  graceMs = 5_000,
  forceWaitMs = 2_000,
  startTimeoutMs = 20_000,
  allowUnreadyCurrent = false,
  premiereControlledOutageDrill = false,
  dryRun = false,
}) {
  validateInputs({
    readyUrl,
    graceMs,
    forceWaitMs,
    startTimeoutMs,
    allowUnreadyCurrent,
    premiereControlledOutageDrill,
  });
  const mode = premiereControlledOutageDrill
    ? "premiere-controlled-outage-drill"
    : "restart";
  const installed = await verifyInstalled(host, plistPath);
  const current = await host.readManaged(TARGET);
  if (!current) throw new Error(`LaunchAgent is not running: ${TARGET}`);
  validateOwnedGroup(current, installed.projectDir);
  validateDirectServer(current);
  if ((await host.readWriterPid(writerLockPath)) !== current.pid) {
    throw new Error("writer lock is not owned by launchd's direct server PID");
  }
  const currentReady = await host.ready(readyUrl);
  if (!currentReady && !allowUnreadyCurrent) {
    // prettier-ignore
    throw new Error("current server failed the readiness preflight; fix --ready-url or pass --allow-unready-current for hang recovery");
  }
  if (dryRun) {
    // prettier-ignore
    return {
      mode, dryRun: true, target: TARGET, pid: current.pid,
      pgid: current.pgid, ownedPids: current.members.map((member) => member.pid),
      projectDir: installed.projectDir, currentReady,
      ...(premiereControlledOutageDrill ? {
        signal: PREMIERE_CONTROLLED_OUTAGE_DRILL_SIGNAL,
        requiredDwellMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS,
        maximumDwellMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS,
        verificationScope: "process_dwell_and_manifest_readiness_only",
        ledgerVerificationRequired: true,
      } : {}),
    };
  }

  const drillStartedAt = premiereControlledOutageDrill ? hostNowMs(host) : null;
  const stopped = premiereControlledOutageDrill
    ? await runControlledOutageDrill(host, current, { graceMs, forceWaitMs })
    : await terminateOwnedGroup(host, current, { graceMs, forceWaitMs });
  const replacementStartedAt = hostNowMs(host);
  const replacement = await replacementReady(host, {
    target: TARGET,
    oldPid: current.pid,
    expectedCwd: installed.projectDir,
    writerLockPath,
    readyUrl,
    startTimeoutMs,
    deadlineAt: replacementStartedAt + startTimeoutMs,
  });
  const replacementFinishedAt = hostNowMs(host);
  const measuredReplacementMs = Math.max(
    0,
    replacementFinishedAt - replacementStartedAt,
  );
  const measuredTotalMs =
    drillStartedAt === null
      ? null
      : Math.max(0, replacementFinishedAt - drillStartedAt);
  if (premiereControlledOutageDrill && !stopped.cooperative) {
    const failure = stopped.fallbackTerm
      ? "validated Node leader required TERM/KILL fallback"
      : `old PID exited outside the required ${PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS}-${PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS}ms dwell window`;
    throw new Error(
      `controlled outage drill failed after replacement readiness: ${failure}`,
    );
  }
  if (
    premiereControlledOutageDrill &&
    (measuredTotalMs === null ||
      measuredTotalMs >= PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_TOTAL_MS)
  ) {
    throw new Error(
      `controlled outage drill exceeded the ${PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_TOTAL_MS}ms total success budget`,
    );
  }
  // prettier-ignore
  return {
    mode, dryRun: false, oldPid: current.pid, oldPgid: current.pgid,
    newPid: replacement.pid, newPgid: replacement.pgid, writerPid: replacement.pid,
    forced: stopped.forced, ready: true, currentReady,
    ...(premiereControlledOutageDrill ? {
      signal: PREMIERE_CONTROLLED_OUTAGE_DRILL_SIGNAL,
      requiredDwellMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MIN_DWELL_MS,
      maximumDwellMs: PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_DWELL_MS,
      measuredDwellMs: stopped.dwellMs,
      measuredReplacementMs,
      measuredTotalMs,
      fallbackTerm: stopped.fallbackTerm,
      verificationScope: "process_dwell_and_manifest_readiness_only",
      ledgerVerificationRequired: true,
    } : {}),
  };
}

function assertCapturedMembers(
  managed,
  current,
  { allowPostTermReparent = false } = {},
) {
  const captured = new Map(
    managed.members.map((member) => [member.pid, member]),
  );
  const currentPids = new Set(current.map((member) => member.pid));
  for (const member of current) {
    const before = captured.get(member.pid);
    const sameParent = before?.ppid === member.ppid;
    const safelyReparented =
      allowPostTermReparent &&
      before !== undefined &&
      member.pid !== managed.pid &&
      member.ppid === 1 &&
      !currentPids.has(before.ppid);
    // prettier-ignore
    if (before === undefined || before.uid !== member.uid || (!sameParent && !safelyReparented) || before.pgid !== member.pgid ||
        before.start !== member.start || before.executable !== member.executable ||
        before.cwd !== member.cwd) {
      throw new Error("PGID membership changed before signal");
    }
  }
}

async function replacementReady(host, options) {
  let lastFailure = "replacement not started";
  const assertBeforeDeadline = () => {
    if (hostNowMs(host) >= options.deadlineAt) {
      throw new Error("replacement readiness deadline exceeded");
    }
  };
  const accepted = await wait(host, options.startTimeoutMs, async () => {
    try {
      assertBeforeDeadline();
      const candidate = await host.readManaged(options.target);
      if (candidate === null || candidate.pid === options.oldPid) return false;
      validateOwnedGroup(candidate, options.expectedCwd);
      validateDirectServer(candidate);
      const candidateWriterPid = await host.readWriterPid(
        options.writerLockPath,
      );
      if (candidateWriterPid !== candidate.pid) {
        throw new Error("replacement writer mismatch");
      }
      assertBeforeDeadline();
      const candidateReady = await host.ready(options.readyUrl);
      assertBeforeDeadline();
      if (!candidateReady) throw new Error("replacement not ready");
      await host.sleep(100);
      const stable = await host.readManaged(options.target);
      if (stable === null) throw new Error("replacement disappeared");
      validateOwnedGroup(stable, options.expectedCwd);
      validateDirectServer(stable);
      assertSameManagedIdentity(candidate, stable);
      const stableWriterPid = await host.readWriterPid(options.writerLockPath);
      if (stableWriterPid !== candidate.pid) {
        throw new Error("replacement writer changed");
      }
      assertBeforeDeadline();
      const stableReady = await host.ready(options.readyUrl);
      assertBeforeDeadline();
      if (!stableReady) {
        throw new Error("replacement readiness changed");
      }
      // Do not accept the second sample if any validation work reached the
      // absolute replacement deadline.
      assertBeforeDeadline();
      return stable;
    } catch (error) {
      lastFailure = error.message;
      return false;
    }
  });
  if (!accepted)
    throw new Error(`replacement acceptance failed: ${lastFailure}`);
  return accepted;
}

function assertSameManagedIdentity(before, after) {
  if (
    before.pid !== after.pid ||
    before.pgid !== after.pgid ||
    before.start !== after.start ||
    before.command !== after.command ||
    before.members.length !== after.members.length
  ) {
    throw new Error("replacement process identity changed");
  }
  const current = new Map(after.members.map((member) => [member.pid, member]));
  for (const member of before.members) {
    const stable = current.get(member.pid);
    if (
      stable === undefined ||
      member.uid !== stable.uid ||
      member.ppid !== stable.ppid ||
      member.pgid !== stable.pgid ||
      member.start !== stable.start ||
      member.executable !== stable.executable ||
      member.cwd !== stable.cwd
    ) {
      throw new Error("replacement process identity changed");
    }
  }
}

async function verifyInstalled(host, plistPath) {
  await safeFile(plistPath, false);
  const config = await host.readPlist(plistPath);
  const args = config?.ProgramArguments;
  const projectDir = config?.EnvironmentVariables?.PROXYWAR_PROJECT_DIR;
  must(config?.Label === LABEL, "plist label");
  must(Array.isArray(args) && args.length === 2, "plist arguments");
  must(args[0] === "/bin/zsh", "plist interpreter");
  must(path.isAbsolute(args[1] ?? ""), "plist wrapper path");
  // prettier-ignore
  must(args[1].endsWith("/Library/Application Support/ProxyWar/bin/start-proxywar-beta.zsh"), "plist wrapper target");
  // prettier-ignore
  must(config.KeepAlive === true && config.RunAtLoad === true, "plist liveness");
  must(config.AbandonProcessGroup === false, "plist process-group policy");
  // prettier-ignore
  must(Number.isInteger(config.ExitTimeOut) && config.ExitTimeOut >= 1 && config.ExitTimeOut <= 30, "plist exit timeout");
  // prettier-ignore
  must(typeof projectDir === "string" && path.isAbsolute(projectDir), "plist project path");
  must(!projectDir.includes("YOUR_USER"), "rendered project path");
  // prettier-ignore
  must(path.resolve(config.WorkingDirectory ?? "") === path.resolve(projectDir), "plist working directory");
  await safeFile(args[1], true);
  const wrapper = await readFile(args[1], "utf8");
  // prettier-ignore
  if (!wrapper.includes('"$NODE_BIN" --import tsx src/scripts/ai-agent-demo-server.ts') ||
      wrapper.includes("npm run agent:closed-beta:prod")) {
    throw new Error("installed wrapper does not directly exec the writer server");
  }
  return { projectDir: path.resolve(projectDir) };
}

async function safeFile(filePath, executable) {
  const absolute = path.resolve(filePath);
  // prettier-ignore
  const [stats, resolved] = await Promise.all([lstat(absolute), realpath(absolute)]);
  // prettier-ignore
  if (!stats.isFile() || stats.isSymbolicLink() || resolved !== absolute ||
      stats.uid !== process.getuid() || (stats.mode & 0o022) !== 0 ||
      (executable && (stats.mode & 0o100) === 0)) {
    throw new Error(`unsafe launch file: ${absolute}`);
  }
}

export function hostController({ exec = execFileAsync } = {}) {
  const launchctl = "/bin/launchctl";
  const ps = "/bin/ps";
  const lsof = "/usr/sbin/lsof";
  const plutil = "/usr/bin/plutil";
  const host = {
    async readManaged(target) {
      let output;
      try {
        output = (await exec(launchctl, ["print", target], { maxBuffer: 4e6 }))
          .stdout;
      } catch {
        return null;
      }
      const pid = Number(output.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
      if (!Number.isSafeInteger(pid)) return null;
      const pgid = Number(await psField(exec, ps, pid, "pgid="));
      const members = await host.snapshotGroup(pgid, pid);
      const root = members.find((member) => member.pid === pid);
      if (!root) return null;
      // prettier-ignore
      return { ...root, command: await psField(exec, ps, pid, "command=", true), members };
    },
    async snapshotGroup(pgid, managedPid = pgid, requireManaged = true) {
      const initial = await processTable(exec, ps);
      if (requireManaged) assertManagedPresent(initial, pgid, managedPid);
      try {
        return await inspectLiveMembers(exec, lsof, initial, pgid, managedPid);
      } catch (error) {
        if (!(error instanceof CwdLookupFailure)) throw error;

        // A process can exit between ps and lsof. Resample the whole table once
        // so a newly joined live member cannot be hidden by that race.
        const current = await processTable(exec, ps);
        const before = error.process;
        const after = current.get(before.pid);
        if (requireManaged)
          assertManagedPresent(current, pgid, managedPid, error);
        if (after !== undefined) {
          if (after.start !== before.start) {
            throw new Error(
              `process ${before.pid} was reused during cwd lookup`,
              { cause: error },
            );
          }
          if (after.pgid !== before.pgid) {
            // prettier-ignore
            throw new Error(`process ${before.pid} changed process group during cwd lookup`, { cause: error });
          }
          if (!isZombie(after)) {
            throw new Error(`cwd unreadable for live process ${before.pid}`, {
              cause: error,
            });
          }
          refuseManagedZombie(after, managedPid);
        }
        return inspectLiveMembers(exec, lsof, current, pgid, managedPid, false);
      }
    },
    async signalGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    },
    async signalProcess(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    },
    async groupExists(pgid) {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        if (error?.code === "EPERM") return true;
        throw error;
      }
    },
    async groupGone(pgid) {
      return !(await host.groupExists(pgid));
    },
    async readWriterPid(lockPath) {
      const stats = await lstat(lockPath);
      const value = JSON.parse(await readFile(lockPath, "utf8"));
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.uid !== (process.getuid?.() ?? stats.uid) ||
        (stats.mode & 0o077) !== 0 ||
        value?.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.pid)
      ) {
        throw new Error("unsafe writer lock");
      }
      return value.pid;
    },
    async readPlist(filePath) {
      // prettier-ignore
      const { stdout } = await exec(plutil, ["-convert", "json", "-o", "-", filePath], { maxBuffer: 1e6 });
      return JSON.parse(stdout);
    },
    async ready(url) {
      try {
        // prettier-ignore
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
        await response.body?.cancel();
        return response.status === 200;
      } catch {
        return false;
      }
    },
    async sleep(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
  return host;
}

class CwdLookupFailure extends Error {
  constructor(process, cause) {
    super(`cwd lookup failed for process ${process.pid}`, { cause });
    this.process = process;
  }
}

async function processTable(exec, ps) {
  // STAT and lstart come from the same ps row, binding zombie classification
  // to the PID/start identity used by every later ownership comparison.
  // prettier-ignore
  const { stdout } = await exec(ps, ["-axo", "uid=,pid=,ppid=,pgid=,stat=,lstart=,ucomm="], { maxBuffer: 4e6 });
  const processes = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 11) throw new Error(`malformed ps row: ${line.trim()}`);
    const [uid, pid, ppid, pgid] = fields.slice(0, 4).map(Number);
    const stat = fields[4];
    const start = fields.slice(5, 10).join(" ");
    const executable = fields.slice(10).join(" ");
    if (
      ![uid, pid, ppid, pgid].every(Number.isSafeInteger) ||
      pid <= 0 ||
      !stat ||
      !start ||
      !executable ||
      processes.has(pid)
    ) {
      throw new Error(`malformed ps row: ${line.trim()}`);
    }
    processes.set(pid, {
      uid,
      pid,
      ppid,
      pgid,
      stat,
      start,
      executable,
    });
  }
  return processes;
}

async function inspectLiveMembers(
  exec,
  lsof,
  processes,
  pgid,
  managedPid,
  allowResnapshot = true,
) {
  const members = [];
  for (const process of processes.values()) {
    if (process.pgid !== pgid) continue;
    if (isZombie(process)) {
      refuseManagedZombie(process, managedPid);
      continue;
    }
    let cwd;
    try {
      cwd = await processCwd(exec, lsof, process.pid);
    } catch (error) {
      if (allowResnapshot) throw new CwdLookupFailure(process, error);
      throw new Error(`cwd unreadable for live process ${process.pid}`, {
        cause: error,
      });
    }
    members.push({ ...process, cwd });
  }
  return members;
}

function isZombie(process) {
  return process.stat.startsWith("Z");
}

function refuseManagedZombie(process, managedPid) {
  if (process.pid === managedPid) {
    throw new Error(`managed PID ${managedPid} is a zombie`);
  }
}

function assertManagedPresent(processes, pgid, managedPid, cause) {
  const managed = processes.get(managedPid);
  if (managed === undefined) {
    throw new Error(`managed PID ${managedPid} disappeared during snapshot`, {
      ...(cause === undefined ? {} : { cause }),
    });
  }
  if (managed.pgid !== pgid) {
    throw new Error(`managed PID ${managedPid} changed process group`, {
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

async function psField(exec, ps, pid, name, wide = false) {
  const args = [...(wide ? ["-ww"] : []), "-p", String(pid), "-o", name];
  // prettier-ignore
  const value = (await exec(ps, args, { maxBuffer: 262144 })).stdout.trim();
  if (!value) throw new Error(`process ${pid} disappeared`);
  return value;
}

async function processCwd(exec, lsof, pid) {
  // prettier-ignore
  const value = (await exec(lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  if (!value || !path.isAbsolute(value)) throw new Error(`no cwd for ${pid}`);
  return value;
}

async function wait(host, timeoutMs, probe) {
  const deadline = hostNowMs(host) + timeoutMs;
  while (hostNowMs(host) < deadline) {
    const value = await probe();
    if (value) return value;
    await host.sleep(Math.min(50, Math.max(1, deadline - hostNowMs(host))));
  }
  return false;
}

function hostNowMs(host) {
  return host.nowMs?.() ?? Date.now();
}

function validateInputs(values) {
  const url = new URL(values.readyUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("ready URL must be loopback HTTP");
  }
  if (
    values.premiereControlledOutageDrill &&
    (!/^\/api\/premieres\/prem_[a-z0-9]{16,32}\/manifest$/.test(url.pathname) ||
      url.search !== "" ||
      url.hash !== "")
  ) {
    throw new Error(
      "controlled outage drill requires --ready-url for the exact active Premiere manifest",
    );
  }
  // prettier-ignore
  for (const ms of [values.graceMs, values.forceWaitMs, values.startTimeoutMs]) {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 120_000) {
      throw new Error("invalid restart duration");
    }
  }
  if (
    values.premiereControlledOutageDrill &&
    values.graceMs !== PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS
  ) {
    throw new Error(
      `controlled outage drill requires --grace-ms=${PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS}`,
    );
  }
  if (
    values.premiereControlledOutageDrill &&
    values.startTimeoutMs >
      PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS
  ) {
    throw new Error(
      `controlled outage drill requires --start-timeout-ms<=${PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS}`,
    );
  }
  if (
    values.premiereControlledOutageDrill &&
    values.forceWaitMs > PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS
  ) {
    throw new Error(
      `controlled outage drill requires --force-wait-ms<=${PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS}`,
    );
  }
  if (values.premiereControlledOutageDrill && values.allowUnreadyCurrent) {
    throw new Error("controlled outage drill requires a ready current server");
  }
}

function must(condition, field) {
  if (!condition) throw new Error(`unsafe or unrendered ${field}`);
}

export function parseRestartCliArguments(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--premiere-controlled-outage-drill")
      options.premiereControlledOutageDrill = true;
    else if (arg === "--allow-unready-current")
      options.allowUnreadyCurrent = true;
    else if (arg.startsWith("--plist=")) options.plistPath = arg.slice(8);
    else if (arg.startsWith("--writer-lock="))
      options.writerLockPath = arg.slice(14);
    else if (arg.startsWith("--ready-url=")) options.readyUrl = arg.slice(12);
    else if (arg.startsWith("--grace-ms="))
      options.graceMs = Number(arg.slice(11));
    else if (arg.startsWith("--force-wait-ms="))
      options.forceWaitMs = Number(arg.slice(16));
    else if (arg.startsWith("--start-timeout-ms="))
      options.startTimeoutMs = Number(arg.slice(19));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.premiereControlledOutageDrill) {
    options.graceMs ??= PREMIERE_CONTROLLED_OUTAGE_DRILL_GRACE_MS;
    options.forceWaitMs ??= PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_FORCE_WAIT_MS;
    options.startTimeoutMs ??=
      PREMIERE_CONTROLLED_OUTAGE_DRILL_MAX_START_TIMEOUT_MS;
  }
  return options;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    // prettier-ignore
    const output = await restartBeta({ host: hostController(), ...parseRestartCliArguments(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ProxyWar beta restart refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
