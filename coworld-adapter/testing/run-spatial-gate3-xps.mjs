#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COWORLD = ["--from", "coworld==0.1.42", "coworld"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${result.status}`,
        typeof result.stdout === "string" ? result.stdout : "",
        typeof result.stderr === "string" ? result.stderr : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

function coworld(args, options) {
  return run("uvx", [...COWORLD, ...args], options);
}

export function decodePythonBytesLiteral(raw) {
  const value = raw.trim();
  if (
    value.length < 3 ||
    value[0] !== "b" ||
    !["'", '"'].includes(value[1]) ||
    value.at(-1) !== value[1]
  ) {
    throw new Error("Coworld log is not a Python bytes literal");
  }
  const bytes = [];
  const inner = value.slice(2, -1);
  const simpleEscapes = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    "\\": 0x5c,
    "'": 0x27,
    '"': 0x22,
  };
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character !== "\\") {
      const code = character.codePointAt(0);
      if (code > 0x7f) {
        throw new Error(
          "Python bytes literal contains an unescaped non-ASCII byte",
        );
      }
      bytes.push(code);
      continue;
    }
    index += 1;
    const escape = inner[index];
    if (escape === undefined) throw new Error("truncated Python bytes escape");
    if (Object.hasOwn(simpleEscapes, escape)) {
      bytes.push(simpleEscapes[escape]);
      continue;
    }
    if (escape === "x") {
      const hex = inner.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/u.test(hex)) {
        throw new Error("invalid Python hex escape");
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (/^[0-7]$/u.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && /^[0-7]$/u.test(inner[index + 1] ?? "")) {
        index += 1;
        octal += inner[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(0x5c, escape.codePointAt(0));
  }
  return Buffer.from(bytes);
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJSON(file, value, options) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function load(root) {
  const resolved = path.resolve(root);
  const index = await readJSON(path.join(resolved, "gate3-index.json"));
  const phaseCounts = {
    canary: { requests: 48, sets: 24 },
    confirmatory: { requests: 96, sets: 48 },
  };
  const expected = phaseCounts[index.phase ?? "canary"];
  if (
    !expected ||
    index.schemaVersion !== 1 ||
    index.validation?.requestCount !== expected.requests ||
    index.validation?.setCount !== expected.sets ||
    index.entries?.length !== expected.requests
  ) {
    throw new Error("Gate 3 index failed frozen cardinality checks");
  }
  return { resolved, index };
}

function parseLimit(argv) {
  const raw = argv.find((arg) => arg.startsWith("--max="))?.slice(6);
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--max must be a positive integer");
  }
  return value;
}

async function inventory(root) {
  const { resolved, index } = await load(root);
  const rows = [];
  for (const entry of index.entries) {
    const receiptFile = path.join(resolved, "create", entry.filename);
    const statusFile = path.join(resolved, "status", entry.filename);
    let receipt = null;
    let status = null;
    try {
      receipt = await readJSON(receiptFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      status = await readJSON(statusFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    rows.push({
      setID: entry.setID,
      arm: entry.arm,
      xreqID: receipt?.id ?? null,
      status: status?.status ?? null,
      completed: status?.completed_count ?? 0,
      failed: status?.failed_count ?? 0,
    });
  }
  const counts = Object.fromEntries(
    ["missing", "pending", "submitted", "running", "completed", "failed"].map(
      (status) => [
        status,
        rows.filter((row) => (row.status ?? "missing") === status).length,
      ],
    ),
  );
  return { resolved, requestCount: rows.length, counts, rows };
}

async function create(root, argv) {
  const limit = parseLimit(argv);
  const { resolved, index } = await load(root);
  let created = 0;
  let skipped = 0;
  for (const entry of index.entries) {
    const receiptFile = path.join(resolved, "create", entry.filename);
    try {
      await fs.access(receiptFile);
      skipped += 1;
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (created >= limit) break;
    const requestFile = path.join(resolved, "requests", entry.filename);
    const stdout = coworld(["xp-request", "create", requestFile, "--json"]);
    const receipt = JSON.parse(stdout);
    if (typeof receipt.id !== "string" || !receipt.id.startsWith("xreq_")) {
      throw new Error(`${entry.filename} create response lacks an xreq ID`);
    }
    await writeJSON(receiptFile, receipt, { flag: "wx" });
    created += 1;
    process.stdout.write(
      `${JSON.stringify({ event: "created", setID: entry.setID, arm: entry.arm, xreqID: receipt.id })}\n`,
    );
  }
  return { created, skipped };
}

async function poll(root) {
  const { resolved, index } = await load(root);
  let refreshed = 0;
  for (const entry of index.entries) {
    const receiptFile = path.join(resolved, "create", entry.filename);
    let receipt;
    try {
      receipt = await readJSON(receiptFile);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const statusFile = path.join(resolved, "status", entry.filename);
    try {
      const previous = await readJSON(statusFile);
      if (["completed", "failed"].includes(previous.status)) continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const stdout = coworld(["xp-request", "get", receipt.id, "--json"]);
    const status = JSON.parse(stdout);
    await writeJSON(statusFile, status);
    refreshed += 1;
  }
  return { refreshed, ...(await inventory(root)) };
}

async function fetchEvidence(root) {
  const { resolved, index } = await load(root);
  let fetched = 0;
  let skipped = 0;
  for (const entry of index.entries) {
    const statusFile = path.join(resolved, "status", entry.filename);
    let status;
    try {
      status = await readJSON(statusFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        skipped += 1;
        continue;
      }
      throw error;
    }
    if (
      status.status !== "completed" ||
      status.failed_count !== 0 ||
      status.episodes?.length !== 1 ||
      status.episodes[0].status !== "completed"
    ) {
      skipped += 1;
      continue;
    }
    const episode = status.episodes[0];
    const evidenceDirectory = path.join(
      resolved,
      "evidence",
      entry.setID,
      entry.arm,
    );
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const resultsFile = path.join(evidenceDirectory, "results.json");
    const logFile = path.join(
      evidenceDirectory,
      `subject-seat-${entry.subjectSlot}.log`,
    );
    const replayFile = path.join(evidenceDirectory, "episode.replay");
    const episodeFile = path.join(evidenceDirectory, "episode.json");
    const completeFiles = [resultsFile, logFile, replayFile, episodeFile];
    const alreadyFetched = await Promise.all(
      completeFiles.map(async (file) => {
        try {
          await fs.access(file);
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    if (alreadyFetched.every(Boolean)) {
      skipped += 1;
      continue;
    }
    coworld(["episode-results", episode.id, "-o", resultsFile]);
    const downloadDirectory = path.join(evidenceDirectory, "downloaded");
    await fs.mkdir(downloadDirectory, { recursive: true });
    coworld([
      "episode-logs",
      episode.id,
      "--agent",
      String(entry.subjectSlot),
      "--download-dir",
      downloadDirectory,
    ]);
    const downloadedLogs = (await fs.readdir(downloadDirectory)).filter(
      (file) => file.endsWith(`-policy_agent_${entry.subjectSlot}.log`),
    );
    if (downloadedLogs.length !== 1) {
      throw new Error(
        `${entry.setID}/${entry.arm} expected one downloaded subject log, found ${downloadedLogs.length}`,
      );
    }
    const encodedLog = await fs.readFile(
      path.join(downloadDirectory, downloadedLogs[0]),
      "utf8",
    );
    await fs.writeFile(logFile, decodePythonBytesLiteral(encodedLog));
    if (typeof episode.replay_url !== "string") {
      throw new Error(`${entry.setID}/${entry.arm} has no replay URL`);
    }
    const response = await fetch(episode.replay_url);
    if (!response.ok) {
      throw new Error(
        `${entry.setID}/${entry.arm} replay fetch failed: ${response.status}`,
      );
    }
    await fs.writeFile(replayFile, Buffer.from(await response.arrayBuffer()), {
      flag: "w",
    });
    await writeJSON(episodeFile, episode);
    fetched += 1;
    process.stdout.write(
      `${JSON.stringify({ event: "fetched", setID: entry.setID, arm: entry.arm, episodeID: episode.id })}\n`,
    );
  }
  return { fetched, skipped };
}

async function main(argv) {
  const [command, root, ...rest] = argv;
  if (
    !command ||
    !root ||
    !["inventory", "create", "poll", "fetch"].includes(command)
  ) {
    throw new Error(
      "usage: node run-spatial-gate3-xps.mjs inventory|create|poll|fetch ROOT [--max=N]",
    );
  }
  const result =
    command === "inventory"
      ? await inventory(root)
      : command === "create"
        ? await create(root, rest)
        : command === "poll"
          ? await poll(root)
          : await fetchEvidence(root);
  process.stdout.write(
    `${JSON.stringify({ event: "summary", command, ...result })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
