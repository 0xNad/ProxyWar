const SHA = /^[0-9a-f]{40}$/;

function normalizedRepository(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const normalized = value.toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function workflowRunHead(workflowRun) {
  const sha = workflowRun?.head_sha;
  const branch = workflowRun?.head_branch;
  const repository = normalizedRepository(
    workflowRun?.head_repository?.full_name,
  );
  if (
    workflowRun?.event !== "pull_request" ||
    !SHA.test(sha ?? "") ||
    typeof branch !== "string" ||
    branch.length === 0 ||
    repository === null
  ) {
    return null;
  }
  return { sha, branch, repository };
}

export function workflowRunCandidates(workflowRun, openPulls = []) {
  const head = workflowRunHead(workflowRun);
  if (head === null) return [];

  const directPulls = workflowRun?.pull_requests ?? [];
  if (directPulls.length > 0) {
    return directPulls
      .filter((pull) => Number.isInteger(pull?.number))
      .map((pull) => ({
        number: pull.number,
        expectedHeadSha: head.sha,
      }));
  }

  return openPulls
    .filter(
      (pull) =>
        pull?.head?.sha === head.sha &&
        pull?.head?.ref === head.branch &&
        normalizedRepository(pull?.head?.repo?.full_name) === head.repository,
    )
    .map((pull) => ({
      number: pull.number,
      expectedHeadSha: head.sha,
    }));
}
