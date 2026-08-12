import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POLICY_PATH = fileURLToPath(
  new URL("../automation/trusted-release-policy.json", import.meta.url),
);

export const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));

const LOGIN = /^(?!-)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;

export function normalizeLogin(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const normalized = value.toLowerCase();
  return LOGIN.test(normalized) ? normalized : null;
}

export function isTrustedAuthor(value) {
  const normalized = normalizeLogin(value);
  return normalized !== null && policy.trustedAuthors.includes(normalized);
}

function globMatches(path, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replaceAll("*", "[^/]*")}$`).test(path);
  }
  return path === pattern;
}

export function isTrustBoundaryPath(path) {
  return (
    typeof path === "string" &&
    policy.protectedPaths.some((pattern) => globMatches(path, pattern))
  );
}

export function changedPathsFromPullFiles(files) {
  return (files ?? []).flatMap((file) =>
    [file?.filename, file?.previous_filename].filter(
      (path) => typeof path === "string" && path.length > 0,
    ),
  );
}

export function summarizeChecks(checkRuns) {
  const latest = new Map();
  for (const check of checkRuns ?? []) {
    if (typeof check?.name !== "string") continue;
    const prior = latest.get(check.name);
    const timestamp =
      Date.parse(check.completed_at ?? check.started_at ?? 0) || 0;
    if (prior === undefined || timestamp >= prior.timestamp) {
      latest.set(check.name, {
        timestamp,
        status: check.status,
        conclusion: check.conclusion,
        appId: check.app?.id ?? check.check_suite?.app?.id ?? null,
        appSlug: check.app?.slug ?? check.check_suite?.app?.slug ?? null,
      });
    }
  }
  return Object.fromEntries(latest);
}

export function evaluatePullRequest(input, options = {}) {
  const reasons = [];
  const author = normalizeLogin(input?.authorLogin);
  if (author === null || !policy.trustedAuthors.includes(author)) {
    reasons.push("untrusted-author");
  }
  if (input?.baseBranch !== policy.baseBranch)
    reasons.push("wrong-base-branch");
  if (input?.draft === true) reasons.push("draft");
  if (
    input?.state !== "OPEN" &&
    options.historical !== true &&
    options.mergedRecovery !== true
  )
    reasons.push("not-open");
  if (!SHA.test(input?.headSha ?? "")) reasons.push("invalid-head-sha");
  if (
    input?.expectedHeadSha !== undefined &&
    input.expectedHeadSha !== input.headSha
  ) {
    reasons.push("stale-head-sha");
  }
  if (
    input?.mergeable !== "MERGEABLE" &&
    options.historical !== true &&
    options.mergedRecovery !== true
  ) {
    reasons.push(
      input?.mergeable === "CONFLICTING"
        ? "merge-conflict"
        : "mergeability-unknown",
    );
  }
  if (
    input?.behindBy !== 0 &&
    options.historical !== true &&
    options.mergedRecovery !== true
  )
    reasons.push("branch-not-current");
  if ((input?.unresolvedReviewThreads ?? 0) > 0) {
    reasons.push("unresolved-review-conversations");
  }
  if (input?.reviewDecision === "CHANGES_REQUESTED") {
    reasons.push("changes-requested");
  }

  const labels = new Set(
    (input?.labels ?? [])
      .filter((label) => typeof label === "string")
      .map((label) => label.toLowerCase()),
  );
  if (policy.blockingLabels.some((label) => labels.has(label))) {
    reasons.push("blocking-label");
  }

  const protectedFiles = (input?.files ?? []).filter(isTrustBoundaryPath);
  if (protectedFiles.length > 0 && input?.ownerApprovedTrustBoundary !== true) {
    reasons.push("trust-boundary-change-needs-owner-approval");
  }

  const checks = summarizeChecks(input?.checkRuns);
  const missingChecks = [];
  const failedChecks = [];
  for (const name of policy.requiredChecks) {
    const check = checks[name];
    const allowedConclusions = policy.allowedCheckConclusions?.[name] ?? [
      "success",
    ];
    if (check === undefined) missingChecks.push(name);
    else if (
      check.status !== "completed" ||
      !allowedConclusions.includes(check.conclusion) ||
      check.appId !== policy.requiredCheckApp.id ||
      check.appSlug !== policy.requiredCheckApp.slug
    ) {
      failedChecks.push(name);
    }
  }
  if (options.historical !== true) {
    if (missingChecks.length > 0) reasons.push("required-check-missing");
    if (failedChecks.length > 0) reasons.push("required-check-not-successful");
  }

  return {
    eligible: reasons.length === 0,
    author,
    testedHeadSha: input?.headSha ?? null,
    reasons: [...new Set(reasons)],
    protectedFiles,
    missingChecks,
    failedChecks,
  };
}

const BRANCH_REFRESH_REASONS = new Set([
  "branch-not-current",
  "required-check-missing",
  "required-check-not-successful",
]);

export function canRefreshTrustedBranch(result) {
  return (
    result?.reasons?.includes("branch-not-current") === true &&
    result.reasons.every((reason) => BRANCH_REFRESH_REASONS.has(reason))
  );
}

export function assertReleaseRecordSafe(record) {
  const text = JSON.stringify(record);
  const forbidden = [
    /authorization/i,
    /bearer\s+[a-z0-9._-]+/i,
    /api[_-]?token/i,
    /private[_-]?key/i,
    /credentials\.ya?ml/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(text))
      throw new Error(
        `release record contains forbidden secret marker: ${pattern}`,
      );
  }
  return record;
}
