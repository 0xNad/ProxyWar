const SHA = /^[0-9a-f]{40}$/;

export function selectExactSourceRun(runs, sourceSha) {
  if (!SHA.test(sourceSha ?? "")) return null;
  return (
    (runs ?? [])
      .filter(
        (run) =>
          (run?.event === "push" && run?.head_sha === sourceSha) ||
          (run?.event === "workflow_dispatch" &&
            run?.display_title === `CI ${sourceSha}`),
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at),
      )[0] ?? null
  );
}

export function requiredCiRunAction(run, maxAttempts = 3) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (run === null || run === undefined) return "missing";
  if (run.status !== "completed") return "wait";
  if (run.conclusion === "success") return "pass";

  const attempt = Number.isInteger(run.run_attempt) ? run.run_attempt : 1;
  return attempt < maxAttempts ? "rerun-failed" : "fail";
}
