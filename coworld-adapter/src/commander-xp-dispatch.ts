/**
 * Fail-closed XP request submitter for a frozen Commander XP preregistration.
 *
 * This command creates each request exactly once, in preregistered order. It
 * never retries, cancels, edits, or submits a replacement. A partial failure
 * leaves the already-created immutable receipts on disk for operator review.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  assertCommanderXpConfirmatoryActivationDocument,
  assertCommanderXpExternalPhaseReceiptDocument,
  assertCommanderXpPreRegistrationDocument,
  type CommanderXpConfirmatoryActivation,
  type CommanderXpExternalPhaseReceipt,
} from "../../src/server/agents/CommanderXpVerifier";

const execFileAsync = promisify(execFile);

export interface CommanderXpDispatchInput {
  schemaVersion: 2;
  phase: CommanderXpProtocolPhase;
  preRegistrationPath: string;
  preregistrationReceiptPath: string;
  providerPreflightReceiptPath?: string;
  canaryReceiptPath?: string;
  confirmatoryActivationPath?: string;
  dispatchAuthorizationPath: string;
  coworldCommandPath: string;
  outputDirectory: string;
}

interface CommanderXpDispatchAuthorization {
  schemaVersion: 2;
  authority: "github-actions-pre-dispatch-fence-v1";
  experimentID: string;
  phase: CommanderXpProtocolPhase;
  preRegistrationSha256: string;
  workflowSourceSha: string;
  workflowSourceTreeSha: string;
  authorizedAt: string;
  priorLedgerSha256: string;
  activationSha256: string | null;
  fenceArtifact: {
    id: number;
    name: string;
    digest: string;
    workflowRunID: number;
    workflowRunAttempt: number;
  };
  createdAt: string;
  dispatchAuthorizationSha256: string;
}

export interface CommanderXpDispatchedRequest {
  phase: CommanderXpProtocolPhase;
  replicaIndex: number;
  arm: CommanderXpArm;
  xpRequestID: string;
  submittedRequestPath: string;
  createResponsePath: string;
  createResponseRawPath: string;
}

export async function dispatchCommanderXpRequests(
  input: CommanderXpDispatchInput,
): Promise<{
  phase: CommanderXpProtocolPhase;
  requestCount: number;
  dispatchAuthorizationSha256: string;
  requests: CommanderXpDispatchedRequest[];
}> {
  if (input.schemaVersion !== 2) throw new Error("dispatch schema invalid");
  const commandPath = await canonicalFile(input.coworldCommandPath);
  const preregistration = JSON.parse(
    await fs.readFile(path.resolve(input.preRegistrationPath), "utf8"),
  ) as CommanderXpPreRegistrationV2;
  assertCommanderXpPreRegistrationDocument(preregistration);
  const dispatchAuthorization = await verifyDispatchAuthorization(
    input,
    preregistration,
  );
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
  const xpRequestIDs = new Set<string>();
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
    } catch (error) {
      stdout = commandStdout(error);
      await persistRawCreateResponse(directory, stdout);
      await persistCreateFailure(directory, "COMMAND_EXIT_NONZERO", stdout);
      throw new Error(`dispatch failed at ${runDirectory(request)}`, {
        cause: error,
      });
    }
    const createResponseRawPath = await persistRawCreateResponse(
      directory,
      stdout,
    );
    const receivedAt = new Date().toISOString();
    let rawResponse: Record<string, unknown>;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("not an object");
      }
      rawResponse = parsed as Record<string, unknown>;
    } catch {
      await persistCreateFailure(directory, "RESPONSE_JSON_INVALID", stdout);
      throw new Error(`dispatch response invalid at ${runDirectory(request)}`);
    }
    const xpRequestID = String(rawResponse.id ?? "");
    const createdAt = String(rawResponse.created_at ?? "");
    const status = String(rawResponse.status ?? "");
    if (
      !/^xreq_[A-Za-z0-9-]+$/.test(xpRequestID) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      status !== "submitted" ||
      xpRequestIDs.has(xpRequestID) ||
      Date.parse(createdAt) < Date.parse(submittedAt) ||
      Date.parse(receivedAt) < Date.parse(createdAt)
    ) {
      await persistCreateFailure(
        directory,
        "RESPONSE_IDENTITY_INVALID",
        stdout,
      );
      throw new Error(`dispatch response invalid at ${runDirectory(request)}`);
    }
    xpRequestIDs.add(xpRequestID);
    const createBody = {
      schemaVersion: 2 as const,
      coworldClient: "0.1.42" as const,
      xpRequestID,
      createdAt,
      status,
      receivedAt,
      submittedRequestSha256: submittedRequest.submittedRequestSha256,
      rawResponseSha256: sha256Bytes(stdout),
      rawResponseByteLength: Buffer.byteLength(stdout),
    };
    const createResponsePath = path.join(directory, "create-response.json");
    await writeJsonExclusive(createResponsePath, {
      ...createBody,
      createResponseSha256: sha256Canonical(createBody),
    });
    requests.push({
      phase: request.phase,
      replicaIndex: request.replicaIndex,
      arm: request.arm,
      xpRequestID,
      submittedRequestPath,
      createResponsePath,
      createResponseRawPath,
    });
  }
  const result = {
    phase: input.phase,
    requestCount: requests.length,
    dispatchAuthorizationSha256:
      dispatchAuthorization.dispatchAuthorizationSha256,
    requests,
  };
  await writeJsonExclusive(
    path.join(outputDirectory, "commander-xp-dispatch-receipt-v2.json"),
    result,
  );
  return result;
}

async function verifyDispatchAuthorization(
  input: CommanderXpDispatchInput,
  preregistration: CommanderXpPreRegistrationV2,
): Promise<CommanderXpDispatchAuthorization> {
  const preregistrationReceipt = await readExternalReceipt(
    input.preregistrationReceiptPath,
    preregistration,
    "preregistration",
  );
  let immediateReceipt = preregistrationReceipt;
  let activation: CommanderXpConfirmatoryActivation | null = null;
  if (input.phase === "provider-preflight") {
    if (
      input.providerPreflightReceiptPath !== undefined ||
      input.canaryReceiptPath !== undefined ||
      input.confirmatoryActivationPath !== undefined
    ) {
      throw new Error("provider preflight dispatch authority is invalid");
    }
  } else {
    if (input.providerPreflightReceiptPath === undefined) {
      throw new Error("provider-preflight receipt is required before gameplay");
    }
    const providerReceipt = await readExternalReceipt(
      input.providerPreflightReceiptPath,
      preregistration,
      "provider-preflight",
    );
    if (
      Date.parse(providerReceipt.completedAt) <
      Date.parse(preregistrationReceipt.completedAt)
    ) {
      throw new Error("provider-preflight receipt predates preregistration");
    }
    immediateReceipt = providerReceipt;
    if (input.phase === "canary") {
      if (
        input.canaryReceiptPath !== undefined ||
        input.confirmatoryActivationPath !== undefined
      ) {
        throw new Error("canary dispatch authority is invalid");
      }
    } else {
      if (
        input.canaryReceiptPath === undefined ||
        input.confirmatoryActivationPath === undefined
      ) {
        throw new Error(
          "canary receipt and activation are required before confirmation",
        );
      }
      const canaryReceipt = await readExternalReceipt(
        input.canaryReceiptPath,
        preregistration,
        "canary",
      );
      if (
        Date.parse(canaryReceipt.completedAt) <
        Date.parse(providerReceipt.completedAt)
      ) {
        throw new Error("canary receipt predates provider preflight");
      }
      activation = await readJsonDocument<CommanderXpConfirmatoryActivation>(
        input.confirmatoryActivationPath,
      );
      assertCommanderXpConfirmatoryActivationDocument(
        preregistration,
        canaryReceipt,
        activation,
      );
      immediateReceipt = canaryReceipt;
    }
  }
  if (
    Date.parse(preregistrationReceipt.completedAt) <
    Date.parse(preregistration.createdAt)
  ) {
    throw new Error("preregistration receipt predates preregistration");
  }
  const authorization =
    await readJsonDocument<CommanderXpDispatchAuthorization>(
      input.dispatchAuthorizationPath,
    );
  exactKeys(
    authorization,
    [
      "schemaVersion",
      "authority",
      "experimentID",
      "phase",
      "preRegistrationSha256",
      "workflowSourceSha",
      "workflowSourceTreeSha",
      "authorizedAt",
      "priorLedgerSha256",
      "activationSha256",
      "fenceArtifact",
      "createdAt",
      "dispatchAuthorizationSha256",
    ],
    "dispatch authorization",
  );
  exactKeys(
    authorization.fenceArtifact,
    ["id", "name", "digest", "workflowRunID", "workflowRunAttempt"],
    "dispatch fence artifact",
  );
  const { dispatchAuthorizationSha256, ...body } = authorization;
  const expectedAuthorizedAt =
    activation?.createdAt ?? immediateReceipt.completedAt;
  const expectedActivationSha256 = activation?.activationSha256 ?? null;
  const expectedFenceName =
    `commander-xp-dispatch-fence-${preregistration.experimentID}-${input.phase}-` +
    preregistration.identities.adapterSourceSha;
  if (
    authorization.schemaVersion !== 2 ||
    authorization.authority !== "github-actions-pre-dispatch-fence-v1" ||
    authorization.experimentID !== preregistration.experimentID ||
    authorization.phase !== input.phase ||
    authorization.preRegistrationSha256 !==
      preregistration.preRegistrationSha256 ||
    authorization.workflowSourceSha !==
      preregistration.identities.adapterSourceSha ||
    authorization.workflowSourceTreeSha !==
      preregistration.identities.adapterSourceTreeSha ||
    authorization.authorizedAt !== expectedAuthorizedAt ||
    authorization.priorLedgerSha256 !== immediateReceipt.ledgerSha256 ||
    authorization.activationSha256 !== expectedActivationSha256 ||
    !Number.isFinite(Date.parse(authorization.createdAt)) ||
    Date.parse(authorization.createdAt) < Date.parse(expectedAuthorizedAt) ||
    !Number.isSafeInteger(authorization.fenceArtifact.id) ||
    authorization.fenceArtifact.id < 1 ||
    authorization.fenceArtifact.name !== expectedFenceName ||
    !/^sha256:[0-9a-f]{64}$/.test(authorization.fenceArtifact.digest) ||
    !Number.isSafeInteger(authorization.fenceArtifact.workflowRunID) ||
    authorization.fenceArtifact.workflowRunID < 1 ||
    !Number.isSafeInteger(authorization.fenceArtifact.workflowRunAttempt) ||
    authorization.fenceArtifact.workflowRunAttempt < 1 ||
    dispatchAuthorizationSha256 !== sha256Canonical(body)
  ) {
    throw new Error("dispatch authorization is invalid");
  }
  return authorization;
}

async function readExternalReceipt(
  requestedPath: string,
  preregistration: CommanderXpPreRegistrationV2,
  phase: CommanderXpExternalPhaseReceipt["phase"],
): Promise<CommanderXpExternalPhaseReceipt> {
  const receipt =
    await readJsonDocument<CommanderXpExternalPhaseReceipt>(requestedPath);
  assertCommanderXpExternalPhaseReceiptDocument(
    preregistration,
    receipt,
    phase,
  );
  return receipt;
}

async function readJsonDocument<T>(requestedPath: string): Promise<T> {
  const filePath = await canonicalFile(requestedPath);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dispatch authority document is invalid");
  }
  return parsed as T;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} schema is invalid`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (sha256Canonical(keys) !== sha256Canonical(wanted)) {
    throw new Error(`${label} schema is invalid`);
  }
}

function commandStdout(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "stdout" in error &&
    typeof error.stdout === "string"
  ) {
    return error.stdout;
  }
  return "";
}

async function persistRawCreateResponse(
  directory: string,
  stdout: string,
): Promise<string> {
  const target = path.join(directory, "create-response-raw.json");
  await fs.writeFile(target, stdout, {
    flag: "wx",
  });
  return target;
}

async function persistCreateFailure(
  directory: string,
  code: string,
  stdout: string,
): Promise<void> {
  await writeJsonExclusive(path.join(directory, "create-failure.json"), {
    schemaVersion: 2,
    code,
    rawResponseSha256: sha256Bytes(stdout),
    rawResponseByteLength: Buffer.byteLength(stdout),
  });
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
