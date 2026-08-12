#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  changedPathsFromPullFiles,
  isTrustBoundaryPath,
  isTrustedAuthor,
  policy,
} from "./trusted-pr-policy.mjs";

export function parseQueueIssue(issue) {
  if (
    issue?.user?.login !== "github-actions[bot]" ||
    issue.user.type !== "Bot"
  ) {
    throw new Error("queue issue was not created by github-actions[bot]");
  }
  if (!issue.body?.includes("proxywar-coworld-release-queue-v1")) {
    throw new Error("queue issue marker is missing");
  }
  const field = (name, pattern) => {
    const match = issue.body.match(pattern);
    if (!match) throw new Error(`queue issue is missing ${name}`);
    return match[1];
  };
  return {
    issueNumber: issue.number,
    prNumber: Number.parseInt(field("PR", /- PR: #(\d+)/), 10),
    author: field("Author", /- Author: ([A-Za-z0-9-]+)/).toLowerCase(),
    testedHeadSha: field(
      "tested head SHA",
      /- Tested head SHA: `([0-9a-f]{40})`/,
    ),
    mergeSha: field("merge SHA", /- Merge SHA: `([0-9a-f]{40})`/),
  };
}

export function selectQueueBatch(issues, requestedNumber = null) {
  const eligible = issues
    .filter((issue) => issue.state === "open")
    .filter((issue) =>
      issue.labels?.some((label) => label.name === policy.queueLabel),
    )
    .filter(
      (issue) =>
        !issue.labels?.some((label) => label.name === policy.batchHoldLabel),
    )
    .sort(
      (left, right) =>
        Date.parse(left.merge_order_at ?? left.created_at) -
        Date.parse(right.merge_order_at ?? right.created_at),
    );
  if (requestedNumber !== null) {
    const requested = eligible.find(
      (issue) => issue.number === requestedNumber,
    );
    if (requested && requested.number !== eligible[0]?.number) {
      process.stderr.write(
        `Requested queue issue #${requestedNumber} is not oldest; processing #${eligible[0].number} first.\n`,
      );
    }
  }
  return eligible;
}

export function isBatchQuiet(batch, now = new Date()) {
  if (batch.length === 0) return false;
  const latest = batch.at(-1);
  const mergedAt = Date.parse(latest.merge_order_at ?? latest.created_at);
  if (!Number.isFinite(mergedAt))
    throw new Error("batch merge time is invalid");
  return now.getTime() - mergedAt >= policy.batchQuietMinutes * 60_000;
}

export function validateBatchAncestry(records, comparisons) {
  if (records.length === 0) throw new Error("Coworld batch is empty");
  if (comparisons.length !== Math.max(0, records.length - 1)) {
    throw new Error("Coworld batch ancestry evidence is incomplete");
  }
  const source = records.at(-1);
  for (let index = 0; index < comparisons.length; index += 1) {
    const compare = comparisons[index];
    if (
      compare.behind_by !== 0 ||
      !["ahead", "identical"].includes(compare.status)
    ) {
      throw new Error(
        `batch source ${source.mergeSha} does not contain queued merge ${records[index].mergeSha}`,
      );
    }
  }
  return source;
}

async function run() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const token = process.env.GITHUB_TOKEN;
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!owner || !repo || !token)
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "proxywar-coworld-queue",
  };

  async function api(path) {
    const response = await fetch(`${apiBase}${path}`, { headers });
    if (!response.ok)
      throw new Error(`GET ${path} failed (${response.status})`);
    return response.json();
  }

  async function paginate(path) {
    const entries = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await api(`${path}${separator}per_page=100&page=${page}`);
      entries.push(...batch);
      if (batch.length < 100) return entries;
    }
  }

  const requested = process.env.QUEUE_ISSUE
    ? Number.parseInt(process.env.QUEUE_ISSUE, 10)
    : null;
  const issues = await paginate(
    `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(policy.queueLabel)}`,
  );
  const orderedIssues = await Promise.all(
    issues.map(async (issue) => {
      const record = parseQueueIssue(issue);
      const pr = await api(`/repos/${owner}/${repo}/pulls/${record.prNumber}`);
      if (!pr.merged_at || pr.merge_commit_sha !== record.mergeSha) {
        throw new Error(
          `queue issue #${issue.number} does not match a merged PR`,
        );
      }
      return { ...issue, merge_order_at: pr.merged_at };
    }),
  );
  const batch = selectQueueBatch(orderedIssues, requested);
  if (batch.length === 0) {
    appendFileSync(process.env.GITHUB_OUTPUT, "has_item=false\n");
    process.stdout.write("No queued Coworld release.\n");
    return;
  }
  if (!isBatchQuiet(batch)) {
    appendFileSync(process.env.GITHUB_OUTPUT, "has_item=false\n");
    process.stdout.write(
      `Coworld batch is waiting for ${policy.batchQuietMinutes} quiet minutes after its newest merge.\n`,
    );
    return;
  }

  const records = [];
  for (const issue of batch) {
    const record = parseQueueIssue(issue);
    const [pr, files, reviews] = await Promise.all([
      api(`/repos/${owner}/${repo}/pulls/${record.prNumber}`),
      paginate(`/repos/${owner}/${repo}/pulls/${record.prNumber}/files`),
      paginate(`/repos/${owner}/${repo}/pulls/${record.prNumber}/reviews`),
    ]);
    const labels = new Set(pr.labels.map((label) => label.name));
    if (!pr.merged_at || pr.merge_commit_sha !== record.mergeSha)
      throw new Error("queued merge SHA is not the PR merge SHA");
    if (pr.head.sha !== record.testedHeadSha)
      throw new Error("queued tested head is stale");
    if (pr.base.ref !== policy.baseBranch)
      throw new Error("queued PR did not target main");
    if (
      !isTrustedAuthor(pr.user.login) ||
      pr.user.login.toLowerCase() !== record.author
    ) {
      throw new Error("queued PR author is not an exact trusted login");
    }
    if (!labels.has(policy.auditLabel))
      throw new Error("queued PR lacks the admission audit label");
    if (policy.blockingLabels.some((label) => labels.has(label)))
      throw new Error("queued PR now has a blocking label");
    const protectedFiles =
      changedPathsFromPullFiles(files).filter(isTrustBoundaryPath);
    if (protectedFiles.length > 0) {
      const latestOwnerReview = reviews
        .filter((review) => review.user?.login?.toLowerCase() === "0xnad")
        .sort(
          (left, right) =>
            Date.parse(right.submitted_at ?? 0) -
            Date.parse(left.submitted_at ?? 0),
        )[0];
      if (
        latestOwnerReview?.state !== "APPROVED" ||
        latestOwnerReview.commit_id !== record.testedHeadSha
      ) {
        throw new Error("trust-boundary PR lacks an exact-head 0xNad approval");
      }
    }
    records.push({ ...record, mergedAt: pr.merged_at });
  }

  const candidateSource = records.at(-1);
  const comparisons = await Promise.all(
    records
      .slice(0, -1)
      .map((record) =>
        api(
          `/repos/${owner}/${repo}/compare/${record.mergeSha}...${candidateSource.mergeSha}`,
        ),
      ),
  );
  const source = validateBatchAncestry(records, comparisons);

  for (const [name, value] of Object.entries({
    has_item: "true",
    queue_issue: source.issueNumber,
    pr_number: source.prNumber,
    author: source.author,
    tested_head_sha: source.testedHeadSha,
    merge_sha: source.mergeSha,
    batch_records_json: JSON.stringify(records),
    batch_queue_issues: records.map((record) => record.issueNumber).join("-"),
    batch_pr_numbers: records.map((record) => record.prNumber).join("-"),
    batch_merge_shas: records.map((record) => record.mergeSha).join("-"),
  })) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  process.stdout.write(
    `Validated Coworld batch of ${records.length} queue record(s), source ${source.mergeSha}.\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await run();
