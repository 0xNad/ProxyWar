#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  requiredCiRunAction,
  selectExactSourceRun,
} from "./await-main-ci-policy.mjs";

const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
const token = process.env.GITHUB_TOKEN;
const sourceSha = process.env.SOURCE_SHA;
const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
if (!owner || !repo || !token || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
  throw new Error(
    "GITHUB_REPOSITORY, GITHUB_TOKEN, and a full SOURCE_SHA are required",
  );
}

const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "proxywar-await-main-ci",
};

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  if (response.status === 204) return null;
  const text = await response.text();
  return text.length === 0 ? null : JSON.parse(text);
}

let dispatchedFallback = false;
const requestedReruns = new Set();
const started = Date.now();
while (Date.now() - started < 2 * 60 * 60 * 1000) {
  const payload = await api(
    `/repos/${owner}/${repo}/actions/workflows/ci.yml/runs?branch=main&per_page=100`,
  );
  const run = selectExactSourceRun(payload.workflow_runs, sourceSha);
  const action = requiredCiRunAction(run);
  if (action === "pass") {
    appendFileSync(process.env.GITHUB_OUTPUT, `main_ci_run_id=${run.id}\n`);
    process.stdout.write(`Exact-source main CI passed: ${run.id}\n`);
    process.exit(0);
  }
  if (action === "fail") {
    throw new Error(
      `required main CI run ${run.id} concluded ${run.conclusion} after ${run.run_attempt ?? 1} attempts`,
    );
  }
  if (action === "rerun-failed") {
    const rerunKey = `${run.id}:${run.run_attempt ?? 1}`;
    if (!requestedReruns.has(rerunKey)) {
      await api(
        `/repos/${owner}/${repo}/actions/runs/${run.id}/rerun-failed-jobs`,
        { method: "POST" },
      );
      requestedReruns.add(rerunKey);
      process.stdout.write(
        `Re-running failed jobs for exact-source CI ${run.id} (attempt ${run.run_attempt ?? 1}).\n`,
      );
    }
  }
  if (
    action === "missing" &&
    !dispatchedFallback &&
    Date.now() - started >= 60_000
  ) {
    await api(`/repos/${owner}/${repo}/actions/workflows/ci.yml/dispatches`, {
      method: "POST",
      body: { ref: "main", inputs: { source_sha: sourceSha } },
    });
    dispatchedFallback = true;
    process.stdout.write(
      "No push CI appeared; dispatched the exact-source CI fallback.\n",
    );
  }
  await delay(30_000);
}
throw new Error(`timed out waiting for complete main CI for ${sourceSha}`);
