/**
 * Fail-closed XP request submitter for a frozen Commander XP preregistration.
 *
 * This command creates each request exactly once, in preregistered order. It
 * never retries, cancels, edits, or submits a replacement. A partial failure
 * leaves the already-created immutable receipts on disk for operator review.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  sha256Canonical,
  type CommanderXpArm,
  type CommanderXpPlannedRequest,
  type CommanderXpPreRegistrationV2,
  type CommanderXpProtocolPhase,
} from "../../src/server/agents/CommanderXpProtocol";

const execFileAsync = promisify(execFile);

export interface CommanderXpDispatchInput {
  schemaVersion: 2;
  phase: CommanderXpProtocolPhase;
  preRegistrationPath: string;
  coworldCommandPath: string;
  outputDirectory: string;
}

export interface CommanderXpDispatchedRequest {
  phase: CommanderXpProtocolPhase;
  replicaIndex: number;
  arm: CommanderXpArm;
  xpRequestID: string;
  submittedRequestPath: string;
  createResponsePath: string;
}

export async function dispatchCommanderXpRequests(
  input: CommanderXpDispatchInput,
): Promise<{
  phase: CommanderXpProtocolPhase;
  requestCount: number;
  requests: CommanderXpDispatchedRequest[];
}> {
  if (input.schemaVersion !== 2) throw new Error("dispatch schema invalid");
  const commandPath = await canonicalFile(input.coworldCommandPath);
  const preregistration = JSON.parse(
    await fs.readFile(path.resolve(input.preRegistrationPath), "utf8"),
  ) as CommanderXpPreRegistrationV2;
  const planned =
    input.phase === "provider-preflight"
      ? preregistration.providerPreflightRequests
      : preregistration.requests.filter(
          (request) => request.phase === input.phase,
        );
  const expectedCount =
    input.phase === "provider-preflight"
      ? 3
      : input.phase === "canary"
        ? 12
        : 96;
  if (planned.length !== expectedCount) {
    throw new Error("dispatch request schedule is incomplete");
  }
  const outputDirectory = path.resolve(input.outputDirectory);
  await fs.mkdir(outputDirectory, { recursive: false });
  const requests: CommanderXpDispatchedRequest[] = [];
  for (const request of planned) {
    const directory = path.join(outputDirectory, runDirectory(request));
    await fs.mkdir(directory, { recursive: true });
    const submittedAt = new Date().toISOString();
    const submittedBody = {
      schemaVersion: 2 as const,
      coworldClient: "0.1.42" as const,
      submittedAt,
      requestBody: request.requestBody,
      requestBodySha256: request.requestBodySha256,
    };
    const submittedRequest = {
      ...submittedBody,
      submittedRequestSha256: sha256Canonical(submittedBody),
    };
    const requestBodyPath = path.join(directory, "request-body.json");
    const submittedRequestPath = path.join(directory, "submitted-request.json");
    await Promise.all([
      writeJsonExclusive(requestBodyPath, request.requestBody),
      writeJsonExclusive(submittedRequestPath, submittedRequest),
    ]);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        commandPath,
        ["xp-request", "create", requestBodyPath, "--json"],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch {
      throw new Error(`dispatch failed at ${runDirectory(request)}`);
    }
    const receivedAt = new Date().toISOString();
    const rawResponse = JSON.parse(stdout) as Record<string, unknown>;
    const xpRequestID = String(rawResponse.id ?? "");
    const createdAt = String(rawResponse.created_at ?? "");
    const status = String(rawResponse.status ?? "");
    if (
      !/^xreq_[A-Za-z0-9-]+$/.test(xpRequestID) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      status === "" ||
      Date.parse(createdAt) < Date.parse(submittedAt) ||
      Date.parse(receivedAt) < Date.parse(createdAt)
    ) {
      throw new Error(`dispatch response invalid at ${runDirectory(request)}`);
    }
    const createBody = {
      schemaVersion: 2 as const,
      coworldClient: "0.1.42" as const,
      xpRequestID,
      createdAt,
      status,
      receivedAt,
      submittedRequestSha256: submittedRequest.submittedRequestSha256,
    };
    const createResponsePath = path.join(directory, "create-response.json");
    await Promise.all([
      fs.writeFile(path.join(directory, "create-response-raw.json"), stdout, {
        flag: "wx",
      }),
      writeJsonExclusive(createResponsePath, {
        ...createBody,
        createResponseSha256: sha256Canonical(createBody),
      }),
    ]);
    requests.push({
      phase: request.phase,
      replicaIndex: request.replicaIndex,
      arm: request.arm,
      xpRequestID,
      submittedRequestPath,
      createResponsePath,
    });
  }
  const result = {
    phase: input.phase,
    requestCount: requests.length,
    requests,
  };
  await writeJsonExclusive(
    path.join(outputDirectory, "commander-xp-dispatch-receipt-v2.json"),
    result,
  );
  return result;
}

function runDirectory(request: CommanderXpPlannedRequest): string {
  return `runs/${request.phase}/r${String(request.replicaIndex).padStart(2, "0")}/${request.arm}`;
}

async function canonicalFile(requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  const real = await fs.realpath(absolute);
  if (
    !(await fs.stat(real)).isFile() ||
    (await fs.lstat(absolute)).isSymbolicLink()
  ) {
    throw new Error("dispatch Coworld command is invalid");
  }
  return real;
}

async function writeJsonExclusive(
  target: string,
  value: unknown,
): Promise<void> {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
}

async function runCli(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("usage: commander-xp-dispatch <dispatch-input.json>");
  }
  const input = JSON.parse(
    await fs.readFile(path.resolve(process.argv[2]!), "utf8"),
  ) as CommanderXpDispatchInput;
  console.log(JSON.stringify(await dispatchCommanderXpRequests(input)));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "dispatch failed");
    process.exitCode = 1;
  });
}
