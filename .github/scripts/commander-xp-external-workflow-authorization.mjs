#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SHA1 = /^[0-9a-f]{40}$/;
const WORKFLOW_PATH = ".github/workflows/commander-xp-external-seal.yml";

export function assertCommanderXpExternalWorkflowAuthorization({
  repository,
  sourceSha,
  authorizationSha,
  currentMainSha,
  repositoryVisibility,
  repositoryPrivate,
  mainProtected,
  sourceToAuthorizationStatus,
  authorizationToCurrentStatus,
  sourceWorkflowBlobSha,
  authorizationWorkflowBlobSha,
  currentWorkflowBlobSha,
}) {
  if (
    repository !== "0xNad/ProxyWar" ||
    ![sourceSha, authorizationSha, currentMainSha].every((value) =>
      SHA1.test(value),
    )
  ) {
    throw new Error("Commander XP external workflow identity is invalid");
  }
  if (
    repositoryVisibility !== "public" ||
    repositoryPrivate !== false ||
    mainProtected !== true
  ) {
    throw new Error("Commander XP repository authority is invalid");
  }
  if (
    !["ahead", "identical"].includes(sourceToAuthorizationStatus) ||
    !["ahead", "identical"].includes(authorizationToCurrentStatus)
  ) {
    throw new Error("Commander XP workflow authorization is not monotonic");
  }
  if (
    ![
      sourceWorkflowBlobSha,
      authorizationWorkflowBlobSha,
      currentWorkflowBlobSha,
    ].every((value) => SHA1.test(value)) ||
    sourceWorkflowBlobSha !== authorizationWorkflowBlobSha ||
    sourceWorkflowBlobSha !== currentWorkflowBlobSha
  ) {
    throw new Error("Commander XP external workflow bytes changed");
  }
  return Object.freeze({
    repository,
    sourceSha,
    authorizationSha,
    currentMainSha,
    workflowPath: WORKFLOW_PATH,
    workflowBlobSha: sourceWorkflowBlobSha,
  });
}

async function ghJson(token, endpoint) {
  const { stdout } = await execFile("gh", ["api", endpoint], {
    env: {
      GH_TOKEN: token,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function main() {
  const [sourceSha, authorizationSha] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!token || !repository) {
    throw new Error(
      "Commander XP external workflow authorization is unavailable",
    );
  }
  const [
    repo,
    branch,
    ref,
    sourceCompare,
    currentCompare,
    sourceFile,
    authFile,
  ] = await Promise.all([
    ghJson(token, `repos/${repository}`),
    ghJson(token, `repos/${repository}/branches/main`),
    ghJson(token, `repos/${repository}/git/ref/heads/main`),
    ghJson(
      token,
      `repos/${repository}/compare/${sourceSha}...${authorizationSha}`,
    ),
    ghJson(token, `repos/${repository}/compare/${authorizationSha}...main`),
    ghJson(
      token,
      `repos/${repository}/contents/${WORKFLOW_PATH}?ref=${sourceSha}`,
    ),
    ghJson(
      token,
      `repos/${repository}/contents/${WORKFLOW_PATH}?ref=${authorizationSha}`,
    ),
  ]);
  const currentMainSha = ref?.object?.sha;
  const currentFile = await ghJson(
    token,
    `repos/${repository}/contents/${WORKFLOW_PATH}?ref=${currentMainSha}`,
  );
  const result = assertCommanderXpExternalWorkflowAuthorization({
    repository,
    sourceSha,
    authorizationSha,
    currentMainSha,
    repositoryVisibility: repo?.visibility,
    repositoryPrivate: repo?.private,
    mainProtected: branch?.protected,
    sourceToAuthorizationStatus: sourceCompare?.status,
    authorizationToCurrentStatus: currentCompare?.status,
    sourceWorkflowBlobSha: sourceFile?.sha,
    authorizationWorkflowBlobSha: authFile?.sha,
    currentWorkflowBlobSha: currentFile?.sha,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
