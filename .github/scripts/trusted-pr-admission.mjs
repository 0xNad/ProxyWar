#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { workflowRunCandidates } from "./trusted-pr-events.mjs";
import {
  changedPathsFromPullFiles,
  evaluatePullRequest,
  isTrustedAuthor,
  policy,
} from "./trusted-pr-policy.mjs";

const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
const token = process.env.GITHUB_TOKEN;
const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
const graphqlUrl =
  process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
const dryRun = process.env.DRY_RUN === "true";
const historical = process.env.HISTORICAL === "true";

if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo");
if (!token) throw new Error("GITHUB_TOKEN is required");

const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "proxywar-trusted-pr-admission",
};

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `${method} ${path} failed (${response.status}): ${message.slice(0, 500)}`,
    );
  }
  if (response.status === 204) return null;
  return response.json();
}

async function graphql(query, variables) {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GraphQL failed (${response.status})`);
  const payload = await response.json();
  if (payload.errors?.length)
    throw new Error(`GraphQL: ${JSON.stringify(payload.errors)}`);
  return payload.data;
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

async function reviewMetadata(number) {
  let cursor = null;
  let unresolved = 0;
  let metadata;
  do {
    const data = await graphql(
      `
        query (
          $owner: String!
          $repo: String!
          $number: Int!
          $cursor: String
        ) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              id
              reviewDecision
              headRefOid
              baseRefOid
              mergeable
              mergeStateStatus
              reviewThreads(first: 100, after: $cursor) {
                nodes {
                  isResolved
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { owner, repo, number, cursor },
    );
    const pr = data.repository.pullRequest;
    if (!pr) throw new Error(`PR #${number} not found`);
    unresolved += pr.reviewThreads.nodes.filter(
      (thread) => !thread.isResolved,
    ).length;
    metadata = {
      reviewDecision: pr.reviewDecision,
      headRefOid: pr.headRefOid,
      baseRefOid: pr.baseRefOid,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
    };
    cursor = pr.reviewThreads.pageInfo.hasNextPage
      ? pr.reviewThreads.pageInfo.endCursor
      : null;
  } while (cursor !== null);
  return {
    unresolved,
    ...metadata,
  };
}

function latestReviewByAuthor(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const login = review.user?.login?.toLowerCase();
    if (!login) continue;
    const prior = latest.get(login);
    if (
      !prior ||
      Date.parse(review.submitted_at ?? 0) >=
        Date.parse(prior.submitted_at ?? 0)
    ) {
      latest.set(login, review);
    }
  }
  return latest;
}

async function inspectPullRequest(number, expectedHeadSha, options = {}) {
  const pr = await api(`/repos/${owner}/${repo}/pulls/${number}`);
  const [metadata, files, reviews, checks, mainRef] = await Promise.all([
    reviewMetadata(number),
    paginate(`/repos/${owner}/${repo}/pulls/${number}/files`),
    paginate(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
    api(
      `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100`,
    ),
    api(`/repos/${owner}/${repo}/git/ref/heads/${policy.baseBranch}`),
  ]);
  const compare =
    historical || options.mergedRecovery
      ? { behind_by: 0 }
      : await api(
          `/repos/${owner}/${repo}/compare/${mainRef.object.sha}...${pr.head.sha}`,
        );
  const latestReviews = latestReviewByAuthor(reviews);
  const ownerReview = latestReviews.get("0xnad");
  const input = {
    authorLogin: pr.user.login,
    baseBranch: pr.base.ref,
    draft: pr.draft,
    state: pr.state.toUpperCase(),
    headSha: metadata.headRefOid,
    expectedHeadSha: expectedHeadSha ?? metadata.headRefOid,
    mergeable: metadata.mergeable,
    mergeStateStatus: metadata.mergeStateStatus,
    behindBy: compare.behind_by,
    unresolvedReviewThreads: metadata.unresolved,
    reviewDecision: metadata.reviewDecision,
    labels: pr.labels.map((label) => label.name),
    files: changedPathsFromPullFiles(files),
    checkRuns: checks.check_runs,
    ownerApprovedTrustBoundary:
      ownerReview?.state === "APPROVED" &&
      ownerReview?.commit_id === metadata.headRefOid,
  };
  return {
    pr,
    metadata,
    input,
    result: evaluatePullRequest(input, {
      historical,
      mergedRecovery: options.mergedRecovery === true,
    }),
  };
}

async function ensureLabel(name, color, description) {
  try {
    await api(`/repos/${owner}/${repo}/labels`, {
      method: "POST",
      body: { name, color, description },
    });
  } catch (error) {
    if (!String(error).includes("422")) throw error;
  }
}

async function addLabels(number, names) {
  await api(`/repos/${owner}/${repo}/issues/${number}/labels`, {
    method: "POST",
    body: { labels: names },
  });
}

async function mergeExactHead(nodeId, expectedHeadOid) {
  const data = await graphql(
    `
      mutation ($id: ID!, $head: GitObjectID!) {
        mergePullRequest(
          input: {
            pullRequestId: $id
            expectedHeadOid: $head
            mergeMethod: MERGE
          }
        ) {
          pullRequest {
            number
            merged
            mergedAt
            mergeCommit {
              oid
            }
          }
        }
      }
    `,
    { id: nodeId, head: expectedHeadOid },
  );
  const merged = data.mergePullRequest.pullRequest;
  if (!merged.merged || !merged.mergeCommit?.oid) {
    throw new Error("GitHub did not return a completed exact-head merge");
  }
  return merged;
}

async function findQueueIssue(mergeSha) {
  const query = encodeURIComponent(
    `repo:${owner}/${repo} is:issue in:title "coworld-release:${mergeSha}"`,
  );
  const result = await api(`/search/issues?q=${query}&per_page=10`);
  return result.items[0] ?? null;
}

async function enqueueRelease({ number, author, testedHeadSha, mergeSha }) {
  const existing = await findQueueIssue(mergeSha);
  if (existing) return existing;
  const body = [
    "<!-- proxywar-coworld-release-queue-v1 -->",
    "Unattended trusted-contributor Coworld release queue entry.",
    "",
    `- PR: #${number}`,
    `- Author: ${author}`,
    `- Tested head SHA: \`${testedHeadSha}\``,
    `- Merge SHA: \`${mergeSha}\``,
    `- Enqueued: ${new Date().toISOString()}`,
    "",
    "This issue is an immutable queue record. Labels are not authority; the production worker revalidates author, SHA, files, merge state, and provenance before using production credentials.",
  ].join("\n");
  return api(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: {
      title: `coworld-release:${mergeSha}`,
      body,
      labels: [policy.queueLabel, policy.auditLabel],
    },
  });
}

async function dispatchWorker(queueIssue) {
  await api(
    `/repos/${owner}/${repo}/actions/workflows/coworld-production.yml/dispatches`,
    {
      method: "POST",
      body: {
        ref: policy.baseBranch,
        inputs: { queue_issue: String(queueIssue.number) },
      },
    },
  );
}

async function commentOnce(number, marker, body) {
  const comments = await paginate(
    `/repos/${owner}/${repo}/issues/${number}/comments`,
  );
  if (comments.some((comment) => comment.body?.includes(marker))) return;
  await api(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body: `${marker}\n${body}` },
  });
}

async function processPullRequest(number, expectedHeadSha) {
  const initialPr = await api(`/repos/${owner}/${repo}/pulls/${number}`);
  const mergedRecovery = Boolean(initialPr.merged_at) && !historical;
  const inspected = await inspectPullRequest(number, expectedHeadSha, {
    mergedRecovery,
  });
  if (
    mergedRecovery &&
    !inspected.pr.labels.some((label) => label.name === policy.auditLabel)
  ) {
    inspected.result.eligible = false;
    inspected.result.reasons.push("missing-admission-audit-label");
  }
  const audit = {
    pr: number,
    author: inspected.pr.user.login,
    headSha: inspected.input.headSha,
    eligible: inspected.result.eligible,
    reasons: inspected.result.reasons,
    protectedFiles: inspected.result.protectedFiles,
  };
  process.stdout.write(`${JSON.stringify(audit)}\n`);
  if (mergedRecovery && inspected.result.eligible) {
    if (dryRun) return audit;
    const queueIssue = await enqueueRelease({
      number,
      author: inspected.pr.user.login.toLowerCase(),
      testedHeadSha: inspected.input.headSha,
      mergeSha: inspected.pr.merge_commit_sha,
    });
    await dispatchWorker(queueIssue);
    return {
      ...audit,
      recoveredAfterMerge: true,
      mergeSha: inspected.pr.merge_commit_sha,
      queueIssue: queueIssue.number,
    };
  }
  if (dryRun || historical || !inspected.result.eligible) {
    if (
      !dryRun &&
      inspected.result.reasons.includes(
        "trust-boundary-change-needs-owner-approval",
      )
    ) {
      await commentOnce(
        number,
        "<!-- proxywar-trust-boundary-hold-v1 -->",
        "Unattended merge is blocked because this PR modifies the release trust boundary. An approval from **0xNad on this exact head SHA** is required; labels cannot bypass this gate.",
      );
    }
    return audit;
  }

  await ensureLabel(
    policy.auditLabel,
    "6f42c1",
    "Eligible trusted-contributor release",
  );
  await ensureLabel(
    policy.queueLabel,
    "d4c5f9",
    "Durable Coworld production queue entry",
  );
  await ensureLabel(
    policy.completedLabel,
    "0e8a16",
    "Coworld release verified complete",
  );
  await ensureLabel(
    policy.failedLabel,
    "b60205",
    "Coworld release requires intervention",
  );
  await addLabels(number, [policy.auditLabel]);

  const fresh = await inspectPullRequest(number, inspected.input.headSha);
  if (!fresh.result.eligible)
    throw new Error(
      `PR #${number} changed before auto-merge: ${fresh.result.reasons.join(",")}`,
    );
  const merged = await mergeExactHead(fresh.pr.node_id, fresh.input.headSha);
  await commentOnce(
    number,
    "<!-- proxywar-trusted-admission-v1 -->",
    `Trusted admission passed for **${fresh.pr.user.login}** at exact tested head \`${fresh.input.headSha}\`. GitHub atomically merged that expected head; Coworld deployment is queued from merge \`${merged.mergeCommit.oid}\`.`,
  );
  const queueIssue = await enqueueRelease({
    number,
    author: fresh.pr.user.login.toLowerCase(),
    testedHeadSha: fresh.input.headSha,
    mergeSha: merged.mergeCommit.oid,
  });
  await dispatchWorker(queueIssue);
  return {
    ...audit,
    mergeSha: merged.mergeCommit.oid,
    queueIssue: queueIssue.number,
  };
}

async function eventPullRequests() {
  const explicit = (process.env.PR_NUMBERS ?? "")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter(Number.isInteger);
  if (explicit.length)
    return explicit.map((number) => ({ number, expectedHeadSha: undefined }));
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return [];
  const event = JSON.parse(readFileSync(path, "utf8"));
  if (event.pull_request) {
    return [
      {
        number: event.pull_request.number,
        expectedHeadSha: event.pull_request.head.sha,
      },
    ];
  }
  if (event.workflow_run) {
    const direct = workflowRunCandidates(event.workflow_run);
    if (direct.length > 0) return direct;
    const pulls = await paginate(
      `/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(policy.baseBranch)}`,
    );
    return workflowRunCandidates(event.workflow_run, pulls);
  }
  if (process.env.GITHUB_EVENT_NAME === "schedule") {
    const pulls = await paginate(
      `/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(policy.baseBranch)}`,
    );
    return pulls
      .filter((pr) => isTrustedAuthor(pr.user?.login))
      .map((pr) => ({ number: pr.number, expectedHeadSha: pr.head.sha }));
  }
  return [];
}

const candidates = await eventPullRequests();
if (candidates.length === 0) {
  process.stdout.write("No pull requests found in this event.\n");
} else {
  for (const candidate of candidates) {
    const pr = await api(`/repos/${owner}/${repo}/pulls/${candidate.number}`);
    if (!isTrustedAuthor(pr.user.login) && !dryRun) {
      process.stdout.write(
        `${JSON.stringify({ pr: candidate.number, eligible: false, reasons: ["untrusted-author"] })}\n`,
      );
      continue;
    }
    await processPullRequest(candidate.number, candidate.expectedHeadSha);
  }
}
