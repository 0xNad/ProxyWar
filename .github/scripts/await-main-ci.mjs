#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

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
  return response.status === 204 ? null : response.json();
}

function matchingRun(runs) {
  return runs
    .filter(
      (run) =>
        (run.event === "push" && run.head_sha === sourceSha) ||
        (run.event === "workflow_dispatch" &&
          run.display_title === `CI ${sourceSha}`),
    )
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at),
    )[0];
}

let dispatchedFallback = false;
const started = Date.now();
while (Date.now() - started < 2 * 60 * 60 * 1000) {
  const payload = await api(
    `/repos/${owner}/${repo}/actions/workflows/ci.yml/runs?branch=main&per_page=100`,
  );
  const run = matchingRun(payload.workflow_runs);
  if (run?.status === "completed") {
    if (run.conclusion !== "success") {
      throw new Error(
        `required main CI run ${run.id} concluded ${run.conclusion}`,
      );
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `main_ci_run_id=${run.id}\n`);
    process.stdout.write(`Exact-source main CI passed: ${run.id}\n`);
    process.exit(0);
  }
  if (!run && !dispatchedFallback && Date.now() - started >= 60_000) {
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
