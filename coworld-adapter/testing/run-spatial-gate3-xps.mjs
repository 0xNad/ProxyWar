#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

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
  if (
    index.schemaVersion !== 1 ||
    index.validation?.requestCount !== 48 ||
    index.validation?.setCount !== 24 ||
    index.entries?.length !== 48
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
    const stdout = coworld(["xp-request", "get", receipt.id, "--json"]);
    const status = JSON.parse(stdout);
    await writeJSON(path.join(resolved, "status", entry.filename), status);
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
    coworld(["episode-results", episode.id, "-o", resultsFile]);
    coworld([
      "episode-logs",
      episode.id,
      "--agent",
      String(entry.subjectSlot),
      "-o",
      logFile,
    ]);
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
    await writeJSON(path.join(evidenceDirectory, "episode.json"), episode);
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

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
