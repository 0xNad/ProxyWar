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
  COMMANDER_XP_CREATE_REQUEST_SCHEMA_SHA256,
  COMMANDER_XP_OPENAPI_SHA256,
  COMMANDER_XP_ROSTER_SCHEMAS_SHA256,
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
  xpOpenApiContractPath: string;
  preregistrationReceiptPath: string;
  providerPreflightReceiptPath?: string;
  canaryReceiptPath?: string;
  confirmatoryActivationPath?: string;
  dispatchAuthorizationPath: string;
  coworldCommandPath: string;
  outputDirectory: string;
  recoveryDirectory?: string;
  fenceRecoveryMode?: "adopt-or-create-unseen";
  confirmatoryDispatchMode?: "first-wave-only";
}

interface CommanderXpOpenApiContract {
  schemaVersion: 2;
  authority: "softmax-public-openapi-exact-bytes-v1";
  url: "https://softmax.com/api/observatory/openapi.json";
  fetchedAt: string;
  byteLength: number;
  rawSha256: string;
  coworldClientVersion: "0.1.42";
  createRequestSchema: {
    name: "V2CreateExperienceRequestRequest";
    encoding: "jq-cS-utf8-compact-sorted-json-with-terminal-lf";
    sha256: string;
  };
  rosterSchemas: {
    names: ["V2RosterParticipant", "V2RosterPlayer"];
    encoding: "ordered-concatenation-of-two-jq-cS-utf8-records-with-terminal-lf";
    sha256: string;
  };
  receiptSha256: string;
}

interface CommanderXpOpenApiLiveCheck {
  stage:
    | "request-wave"
    | "confirmatory-first-wave"
    | "confirmatory-second-wave";
  checkedAt: string;
  byteLength: number;
  rawSha256: string;
}

export interface CommanderXpDispatchDependencies {
  revalidateOpenApi?: () => Promise<{
    checkedAt: string;
    byteLength: number;
    rawSha256: string;
  }>;
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
  fenceGitRef: string;
  createdAt: string;
  dispatchAuthorizationSha256: string;
}

interface CommanderXpDispatchProgressEntry {
  phase: CommanderXpProtocolPhase;
  replicaIndex: number;
  arm: CommanderXpArm;
  runPath: string;
  requestBodySha256: string;
  submittedRequestSha256: string;
  wave: 1 | 2;
  status: "prepared" | "submitted" | "terminal" | "failed";
  xpRequestID: string | null;
  rawResponseSha256: string | null;
  rawResponseByteLength: number | null;
  terminalAt: string | null;
  terminalReadbackSha256: string | null;
  failureCode: string | null;
}

interface CommanderXpDispatchProgress {
  schemaVersion: 2;
  authority: "commander-xp-write-through-dispatch-progress-v2";
  phase: CommanderXpProtocolPhase;
  expectedRequestCount: number;
  dispatchAuthorizationSha256: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  status: "running" | "failed" | "completed";
  requests: CommanderXpDispatchProgressEntry[];
  progressSha256: string;
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

export interface CommanderXpRecoveryCandidate {
  id: string;
  created_at: string;
  status: string;
  requested: unknown;
  rawReadback: string;
}

export function selectCommanderXpRecoveryCandidate(
  planned: CommanderXpPlannedRequest,
  candidates: readonly CommanderXpRecoveryCandidate[],
): CommanderXpRecoveryCandidate {
  const matchingKey = candidates.filter((candidate) => {
    if (
      candidate.requested === null ||
      typeof candidate.requested !== "object" ||
      Array.isArray(candidate.requested)
    ) {
      return false;
    }
    return (
      (candidate.requested as Record<string, unknown>).idempotency_key ===
      planned.runKey
    );
  });
  if (matchingKey.length !== 1) {
    throw new Error("Commander XP recovery identity is ambiguous or missing");
  }
  const selected = matchingKey[0]!;
  if (
    !/^xreq_[A-Za-z0-9-]+$/.test(selected.id) ||
    !Number.isFinite(Date.parse(selected.created_at)) ||
    !["submitted", "pending", "running", "completed"].includes(
      selected.status,
    ) ||
    sha256Canonical(selected.requested) !== planned.requestBodySha256 ||
    selected.rawReadback.length === 0
  ) {
    throw new Error("Commander XP recovery candidate does not match the slot");
  }
  return selected;
}

export async function discoverCommanderXpRecoveryCandidate(
  commandPath: string,
  planned: CommanderXpPlannedRequest,
): Promise<CommanderXpRecoveryCandidate> {
  return selectCommanderXpRecoveryCandidate(
    planned,
    await listCommanderXpRecoveryCandidates(commandPath),
  );
}

function selectCommanderXpRecoveryCandidateIfPresent(
  planned: CommanderXpPlannedRequest,
  candidates: readonly CommanderXpRecoveryCandidate[],
): Promise<CommanderXpRecoveryCandidate | null> {
  const matching = candidates.filter(
    (candidate) =>
      candidate.requested !== null &&
      typeof candidate.requested === "object" &&
      !Array.isArray(candidate.requested) &&
      (candidate.requested as Record<string, unknown>).idempotency_key ===
        planned.runKey,
  );
  return Promise.resolve(
    matching.length === 0
      ? null
      : selectCommanderXpRecoveryCandidate(planned, candidates),
  );
}

async function listCommanderXpRecoveryCandidates(
  commandPath: string,
): Promise<CommanderXpRecoveryCandidate[]> {
  const entries: Array<{ id: string }> = [];
  let offset = 0;
  let totalCount: number | null = null;
  do {
    const { stdout } = await execFileAsync(
      commandPath,
      [
        "xp-request",
        "list",
        "--mine",
        "--limit",
        "1000",
        "--offset",
        String(offset),
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const page = JSON.parse(stdout) as {
      entries?: unknown;
      total_count?: unknown;
      limit?: unknown;
      offset?: unknown;
    };
    if (
      !Array.isArray(page.entries) ||
      !Number.isInteger(page.total_count) ||
      Number(page.total_count) < 0 ||
      Number(page.total_count) > 10_000 ||
      page.limit !== 1000 ||
      page.offset !== offset ||
      (totalCount !== null && page.total_count !== totalCount)
    ) {
      throw new Error("Commander XP recovery inventory is invalid");
    }
    totalCount = Number(page.total_count);
    for (const entry of page.entries) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !/^xreq_[A-Za-z0-9-]+$/.test(
          String((entry as Record<string, unknown>).id ?? ""),
        )
      ) {
        throw new Error("Commander XP recovery inventory row is invalid");
      }
      entries.push({ id: String((entry as Record<string, unknown>).id) });
    }
    offset += page.entries.length;
    if (page.entries.length === 0 && offset < totalCount) {
      throw new Error("Commander XP recovery inventory is incomplete");
    }
  } while (totalCount !== null && offset < totalCount);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("Commander XP recovery inventory repeats an ID");
  }
  const candidates: CommanderXpRecoveryCandidate[] = [];
  for (const entry of entries) {
    const { stdout } = await execFileAsync(
      commandPath,
      ["xp-request", "get", entry.id, "--json"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    const detail = JSON.parse(stdout) as Record<string, unknown>;
    if (detail.id !== entry.id) {
      throw new Error("Commander XP recovery readback identity is invalid");
    }
    candidates.push({
      id: entry.id,
      created_at: String(detail.created_at ?? ""),
      status: String(detail.status ?? ""),
      requested: detail.requested,
      rawReadback: stdout,
    });
  }
  return candidates;
}

export async function dispatchCommanderXpConfirmatoryWaves<T>(
  planned: readonly CommanderXpPlannedRequest[],
  submit: (request: CommanderXpPlannedRequest) => Promise<T>,
  awaitFirstWaveTerminal: (
    submitted: readonly {
      request: CommanderXpPlannedRequest;
      result: T;
    }[],
  ) => Promise<void>,
  beforeFirstWave: () => Promise<void> = async () => undefined,
  beforeSecondWave: () => Promise<void> = async () => undefined,
): Promise<void> {
  const firstWave = planned.filter((request) => request.orderIndex === 0);
  const secondWave = planned.filter((request) => request.orderIndex === 1);
  const replicas = new Set(planned.map((request) => request.replicaIndex));
  if (
    planned.length !== 96 ||
    firstWave.length !== 48 ||
    secondWave.length !== 48 ||
    replicas.size !== 48 ||
    [...replicas].some(
      (replicaIndex) =>
        firstWave.filter((request) => request.replicaIndex === replicaIndex)
          .length !== 1 ||
        secondWave.filter((request) => request.replicaIndex === replicaIndex)
          .length !== 1,
    )
  ) {
    throw new Error("confirmatory dispatch waves are incomplete");
  }
  const submitted: Array<{
    request: CommanderXpPlannedRequest;
    result: T;
  }> = [];
  await beforeFirstWave();
  for (const request of firstWave) {
    submitted.push({ request, result: await submit(request) });
  }
  await awaitFirstWaveTerminal(submitted);
  await beforeSecondWave();
  for (const request of secondWave) {
    await submit(request);
  }
}

export async function dispatchCommanderXpRequests(
  input: CommanderXpDispatchInput,
  dependencies: CommanderXpDispatchDependencies = {},
): Promise<{
  phase: CommanderXpProtocolPhase;
  requestCount: number;
  dispatchAuthorizationSha256: string;
  openApiRevalidationSha256: string;
  requests: CommanderXpDispatchedRequest[];
}> {
  if (input.schemaVersion !== 2) throw new Error("dispatch schema invalid");
  const commandPath = await canonicalFile(input.coworldCommandPath);
  const preregistration = JSON.parse(
    await fs.readFile(path.resolve(input.preRegistrationPath), "utf8"),
  ) as CommanderXpPreRegistrationV2;
  assertCommanderXpPreRegistrationDocument(preregistration);
  const openApiContract = await readOpenApiContract(
    input.xpOpenApiContractPath,
    preregistration,
  );
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
  if (
    (input.confirmatoryDispatchMode !== undefined &&
      (input.phase !== "confirmatory" ||
        input.confirmatoryDispatchMode !== "first-wave-only")) ||
    (input.phase !== "confirmatory" &&
      input.confirmatoryDispatchMode !== undefined)
  ) {
    throw new Error("dispatch wave mode is invalid");
  }
  if (
    (input.fenceRecoveryMode !== undefined &&
      input.fenceRecoveryMode !== "adopt-or-create-unseen") ||
    (input.fenceRecoveryMode !== undefined &&
      input.recoveryDirectory !== undefined)
  ) {
    throw new Error("dispatch fence recovery mode is invalid");
  }
  const recovery = await loadRecoveryState(
    input.recoveryDirectory,
    input.phase,
    expectedCount,
    dispatchAuthorization.dispatchAuthorizationSha256,
    planned,
  );
  const outputDirectory = path.resolve(input.outputDirectory);
  await fs.mkdir(outputDirectory, { recursive: false });
  await fs.copyFile(
    await canonicalFile(input.xpOpenApiContractPath),
    path.join(outputDirectory, "xp-openapi-contract-v2.json"),
    fs.constants.COPYFILE_EXCL,
  );
  const requests: CommanderXpDispatchedRequest[] = [];
  const xpRequestIDs = new Set<string>();
  const startedAt = new Date().toISOString();
  let progress: CommanderXpDispatchProgress = buildProgress(
    input.phase,
    expectedCount,
    dispatchAuthorization.dispatchAuthorizationSha256,
    startedAt,
    null,
    "running",
    [],
  );
  let recoveryInventory: CommanderXpRecoveryCandidate[] | null = null;
  await writeDispatchProgress(outputDirectory, progress, true);
  const openApiChecks: CommanderXpOpenApiLiveCheck[] = [];
  let openApiRevalidationSha256 = "";
  const revalidateOpenApi = async (
    stage: CommanderXpOpenApiLiveCheck["stage"],
  ): Promise<void> => {
    const check = await (
      dependencies.revalidateOpenApi ?? fetchLiveOpenApiIdentity
    )();
    if (
      !Number.isFinite(Date.parse(check.checkedAt)) ||
      check.byteLength !== openApiContract.byteLength ||
      check.rawSha256 !== openApiContract.rawSha256
    ) {
      throw new Error(
        "Commander XP live OpenAPI identity changed before dispatch",
      );
    }
    openApiChecks.push({ stage, ...check });
    const body = {
      schemaVersion: 2 as const,
      authority: "commander-xp-pre-dispatch-openapi-revalidation-v2" as const,
      contractReceiptSha256: openApiContract.receiptSha256,
      checks: openApiChecks,
    };
    openApiRevalidationSha256 = sha256Canonical(body);
    await writeJsonAtomic(
      path.join(outputDirectory, "xp-openapi-revalidation-v2.json"),
      { ...body, openApiRevalidationSha256 },
    );
  };
  const submitRequest = async (
    request: CommanderXpPlannedRequest,
  ): Promise<CommanderXpDispatchedRequest> => {
    const directory = path.join(outputDirectory, runDirectory(request));
    await fs.mkdir(directory, { recursive: true });
    const recovered = recovery?.entries.get(runDirectory(request));
    const persistAdoption = async (
      candidate: CommanderXpRecoveryCandidate,
      submittedRequest: {
        schemaVersion: 2;
        coworldClient: "0.1.42";
        submittedAt: string;
        requestBody: unknown;
        requestBodySha256: string;
        submittedRequestSha256: string;
      },
      progressEntry: CommanderXpDispatchProgressEntry,
      priorSubmittedPath?: string,
    ): Promise<CommanderXpDispatchedRequest> => {
      if (xpRequestIDs.has(candidate.id)) {
        throw new Error("Commander XP recovery repeats an XP request ID");
      }
      xpRequestIDs.add(candidate.id);
      const requestBodyPath = path.join(directory, "request-body.json");
      const submittedRequestPath = path.join(
        directory,
        "submitted-request.json",
      );
      await writeJsonExclusive(requestBodyPath, request.requestBody);
      if (priorSubmittedPath === undefined) {
        await writeJsonExclusive(submittedRequestPath, submittedRequest);
      } else {
        await fs.copyFile(
          priorSubmittedPath,
          submittedRequestPath,
          fs.constants.COPYFILE_EXCL,
        );
      }
      const createResponseRawPath = await persistRawCreateResponse(
        directory,
        candidate.rawReadback,
      );
      const receivedAt = new Date().toISOString();
      const createBody = {
        schemaVersion: 2 as const,
        authority: "coworld-0.1.42-xp-create-boundary-v1" as const,
        mode: "authoritative-adoption" as const,
        coworldClient: "0.1.42" as const,
        xpRequestID: candidate.id,
        createdAt: candidate.created_at,
        status: candidate.status as
          | "submitted"
          | "pending"
          | "running"
          | "completed",
        receivedAt,
        submittedRequestSha256: submittedRequest.submittedRequestSha256,
        rawResponseSha256: sha256Bytes(candidate.rawReadback),
        rawResponseByteLength: Buffer.byteLength(candidate.rawReadback),
      };
      const createResponsePath = path.join(directory, "create-response.json");
      await writeJsonExclusive(createResponsePath, {
        ...createBody,
        createResponseSha256: sha256Canonical(createBody),
      });
      const dispatched = {
        phase: request.phase,
        replicaIndex: request.replicaIndex,
        arm: request.arm,
        xpRequestID: candidate.id,
        submittedRequestPath,
        createResponsePath,
        createResponseRawPath,
      };
      requests.push(dispatched);
      progress = buildProgress(
        input.phase,
        expectedCount,
        dispatchAuthorization.dispatchAuthorizationSha256,
        startedAt,
        null,
        "running",
        [
          ...progress.requests,
          {
            ...progressEntry,
            status: "submitted",
            xpRequestID: candidate.id,
            rawResponseSha256: createBody.rawResponseSha256,
            rawResponseByteLength: createBody.rawResponseByteLength,
            terminalAt: null,
            terminalReadbackSha256: null,
            failureCode: null,
          },
        ],
      );
      await writeDispatchProgress(outputDirectory, progress);
      return dispatched;
    };
    if (recovered !== undefined && recovery !== null) {
      const previousDirectory = path.join(recovery.root, runDirectory(request));
      const priorSubmittedPath = path.join(
        previousDirectory,
        "submitted-request.json",
      );
      const submittedRequest = JSON.parse(
        await fs.readFile(priorSubmittedPath, "utf8"),
      ) as {
        schemaVersion: unknown;
        coworldClient: unknown;
        submittedAt: unknown;
        requestBody: unknown;
        requestBodySha256: unknown;
        submittedRequestSha256: unknown;
      };
      const { submittedRequestSha256, ...submittedBody } = submittedRequest;
      exactKeys(
        submittedRequest,
        [
          "schemaVersion",
          "coworldClient",
          "submittedAt",
          "requestBody",
          "requestBodySha256",
          "submittedRequestSha256",
        ],
        "recovery submitted request",
      );
      if (
        submittedRequest.schemaVersion !== 2 ||
        submittedRequest.coworldClient !== "0.1.42" ||
        !Number.isFinite(Date.parse(String(submittedRequest.submittedAt))) ||
        submittedRequest.requestBodySha256 !== request.requestBodySha256 ||
        sha256Canonical(submittedRequest.requestBody) !==
          request.requestBodySha256 ||
        submittedRequestSha256 !== sha256Canonical(submittedBody) ||
        submittedRequestSha256 !== recovered.submittedRequestSha256
      ) {
        throw new Error(
          `Commander XP recovery submitted body is invalid at ${runDirectory(request)}`,
        );
      }
      let candidate: CommanderXpRecoveryCandidate | null;
      if (recovered.xpRequestID === null) {
        recoveryInventory ??=
          await listCommanderXpRecoveryCandidates(commandPath);
        candidate = await selectCommanderXpRecoveryCandidateIfPresent(
          request,
          recoveryInventory,
        );
        if (candidate === null) {
          throw new Error(
            "Commander XP recovery identity is ambiguous or missing",
          );
        }
      } else {
        candidate = await getCommanderXpRecoveryCandidate(
          commandPath,
          request,
          recovered.xpRequestID,
        );
      }
      return persistAdoption(
        candidate,
        submittedRequest as Parameters<typeof persistAdoption>[1],
        recovered,
        priorSubmittedPath,
      );
    }
    if (
      recovery !== null ||
      input.fenceRecoveryMode === "adopt-or-create-unseen"
    ) {
      recoveryInventory ??=
        await listCommanderXpRecoveryCandidates(commandPath);
      const candidate = await selectCommanderXpRecoveryCandidateIfPresent(
        request,
        recoveryInventory,
      );
      if (candidate !== null) {
        const submittedBody = {
          schemaVersion: 2 as const,
          coworldClient: "0.1.42" as const,
          submittedAt: candidate.created_at,
          requestBody: request.requestBody,
          requestBodySha256: request.requestBodySha256,
        };
        const submittedRequest = {
          ...submittedBody,
          submittedRequestSha256: sha256Canonical(submittedBody),
        };
        return persistAdoption(candidate, submittedRequest, {
          phase: request.phase,
          replicaIndex: request.replicaIndex,
          arm: request.arm,
          runPath: runDirectory(request),
          requestBodySha256: request.requestBodySha256,
          submittedRequestSha256: submittedRequest.submittedRequestSha256,
          wave:
            input.phase === "confirmatory" && request.orderIndex === 1 ? 2 : 1,
          status: "prepared",
          xpRequestID: null,
          rawResponseSha256: null,
          rawResponseByteLength: null,
          terminalAt: null,
          terminalReadbackSha256: null,
          failureCode: null,
        });
      }
    }
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
    const progressEntry: CommanderXpDispatchProgressEntry = {
      phase: request.phase,
      replicaIndex: request.replicaIndex,
      arm: request.arm,
      runPath: runDirectory(request),
      requestBodySha256: request.requestBodySha256,
      submittedRequestSha256: submittedRequest.submittedRequestSha256,
      wave: input.phase === "confirmatory" && request.orderIndex === 1 ? 2 : 1,
      status: "prepared",
      xpRequestID: null,
      rawResponseSha256: null,
      rawResponseByteLength: null,
      terminalAt: null,
      terminalReadbackSha256: null,
      failureCode: null,
    };
    progress = buildProgress(
      input.phase,
      expectedCount,
      dispatchAuthorization.dispatchAuthorizationSha256,
      startedAt,
      null,
      "running",
      [...progress.requests, progressEntry],
    );
    await writeDispatchProgress(outputDirectory, progress);
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
      await failDispatchProgress(
        outputDirectory,
        progress,
        "COMMAND_EXIT_NONZERO",
        stdout,
      );
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
      await failDispatchProgress(
        outputDirectory,
        progress,
        "RESPONSE_JSON_INVALID",
        stdout,
      );
      throw new Error(`dispatch response invalid at ${runDirectory(request)}`);
    }
    const xpRequestID = String(rawResponse.id ?? "");
    const createdAt = String(rawResponse.created_at ?? "");
    const status = String(rawResponse.status ?? "");
    // submittedAt/receivedAt are runner observations. Do not order Softmax's
    // server-owned created_at against a potentially skewed runner clock.
    if (
      !/^xreq_[A-Za-z0-9-]+$/.test(xpRequestID) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !["submitted", "pending", "running", "completed"].includes(status) ||
      xpRequestIDs.has(xpRequestID)
    ) {
      await persistCreateFailure(
        directory,
        "RESPONSE_IDENTITY_INVALID",
        stdout,
      );
      await failDispatchProgress(
        outputDirectory,
        progress,
        "RESPONSE_IDENTITY_INVALID",
        stdout,
      );
      throw new Error(`dispatch response invalid at ${runDirectory(request)}`);
    }
    xpRequestIDs.add(xpRequestID);
    const createBody = {
      schemaVersion: 2 as const,
      authority: "coworld-0.1.42-xp-create-boundary-v1" as const,
      mode: "direct-response" as const,
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
    const dispatched = {
      phase: request.phase,
      replicaIndex: request.replicaIndex,
      arm: request.arm,
      xpRequestID,
      submittedRequestPath,
      createResponsePath,
      createResponseRawPath,
    };
    requests.push(dispatched);
    progress = buildProgress(
      input.phase,
      expectedCount,
      dispatchAuthorization.dispatchAuthorizationSha256,
      startedAt,
      null,
      "running",
      [
        ...progress.requests.slice(0, -1),
        {
          ...progress.requests.at(-1)!,
          status: "submitted",
          xpRequestID,
          rawResponseSha256: createBody.rawResponseSha256,
          rawResponseByteLength: createBody.rawResponseByteLength,
        },
      ],
    );
    await writeDispatchProgress(outputDirectory, progress);
    return dispatched;
  };
  if (
    input.phase === "confirmatory" &&
    input.confirmatoryDispatchMode === "first-wave-only"
  ) {
    const dispatchOrder = [
      ...planned.filter((request) => request.orderIndex === 0),
      ...planned.filter((request) => request.orderIndex === 1),
    ];
    const targetCount = Math.max(48, recovery?.entries.size ?? 0);
    if (targetCount > planned.length) {
      throw new Error("confirmatory recovery prefix is too long");
    }
    await revalidateOpenApi("confirmatory-first-wave");
    for (const request of dispatchOrder.slice(0, targetCount)) {
      await submitRequest(request);
    }
    return {
      phase: input.phase,
      requestCount: requests.length,
      dispatchAuthorizationSha256:
        dispatchAuthorization.dispatchAuthorizationSha256,
      openApiRevalidationSha256,
      requests,
    };
  }
  if (input.phase === "confirmatory") {
    await dispatchCommanderXpConfirmatoryWaves(
      planned,
      submitRequest,
      async (submitted) => {
        progress = await waitForConfirmatoryFirstWave({
          commandPath,
          outputDirectory,
          progress,
          submitted,
        });
      },
      async () => revalidateOpenApi("confirmatory-first-wave"),
      async () => revalidateOpenApi("confirmatory-second-wave"),
    );
  } else {
    await revalidateOpenApi("request-wave");
    for (const request of planned) {
      await submitRequest(request);
    }
  }
  const result = {
    phase: input.phase,
    requestCount: requests.length,
    dispatchAuthorizationSha256:
      dispatchAuthorization.dispatchAuthorizationSha256,
    openApiRevalidationSha256,
    requests,
  };
  await writeJsonExclusive(
    path.join(outputDirectory, "commander-xp-dispatch-receipt-v2.json"),
    result,
  );
  const completedAt = new Date().toISOString();
  progress = buildProgress(
    input.phase,
    expectedCount,
    dispatchAuthorization.dispatchAuthorizationSha256,
    startedAt,
    completedAt,
    "completed",
    progress.requests,
  );
  await writeDispatchProgress(outputDirectory, progress);
  return result;
}

async function waitForConfirmatoryFirstWave(input: {
  commandPath: string;
  outputDirectory: string;
  progress: CommanderXpDispatchProgress;
  submitted: readonly {
    request: CommanderXpPlannedRequest;
    result: CommanderXpDispatchedRequest;
  }[];
}): Promise<CommanderXpDispatchProgress> {
  const deadline = Date.now() + 21_600_000;
  const pending = new Map(
    input.submitted.map((entry) => [entry.result.xpRequestID, entry]),
  );
  let progress = input.progress;
  while (pending.size > 0) {
    for (const [xpRequestID, submitted] of [...pending]) {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          input.commandPath,
          ["xp-request", "get", xpRequestID, "--json"],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        ));
      } catch (error) {
        throw new Error(
          `confirmatory first-wave readback failed at ${runDirectory(submitted.request)}`,
          { cause: error },
        );
      }
      const parsed = JSON.parse(stdout) as {
        id?: unknown;
        episodes?: unknown;
      };
      const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
      const episode = episodes.length === 1 ? episodes[0] : null;
      if (
        parsed.id !== xpRequestID ||
        episode === null ||
        typeof episode !== "object" ||
        Array.isArray(episode)
      ) {
        throw new Error(
          `confirmatory first-wave readback invalid at ${runDirectory(submitted.request)}`,
        );
      }
      const record = episode as Record<string, unknown>;
      const status = String(record.status ?? "");
      if (["submitted", "pending", "running"].includes(status)) continue;
      if (status !== "completed") {
        const failedAt = new Date().toISOString();
        progress = buildProgress(
          progress.phase,
          progress.expectedRequestCount,
          progress.dispatchAuthorizationSha256,
          progress.startedAt,
          failedAt,
          "failed",
          progress.requests.map((entry) =>
            entry.xpRequestID === xpRequestID
              ? { ...entry, status: "failed", failureCode: "FIRST_WAVE_FAILED" }
              : entry,
          ),
        );
        await writeDispatchProgress(input.outputDirectory, progress);
        throw new Error(
          `confirmatory first wave failed at ${runDirectory(submitted.request)}`,
        );
      }
      const terminalAt = String(record.completed_at ?? "");
      if (!Number.isFinite(Date.parse(terminalAt))) {
        throw new Error(
          `confirmatory first-wave completion invalid at ${runDirectory(submitted.request)}`,
        );
      }
      const terminalBody = {
        schemaVersion: 2 as const,
        authority: "coworld-0.1.42-first-wave-terminal-readback-v1" as const,
        xpRequestID,
        status: "completed" as const,
        completedAt: terminalAt,
        rawReadbackSha256: sha256Bytes(stdout),
        rawReadbackByteLength: Buffer.byteLength(stdout),
      };
      await writeJsonExclusive(
        path.join(
          input.outputDirectory,
          runDirectory(submitted.request),
          "first-wave-terminal.json",
        ),
        {
          ...terminalBody,
          terminalReceiptSha256: sha256Canonical(terminalBody),
        },
      );
      progress = buildProgress(
        progress.phase,
        progress.expectedRequestCount,
        progress.dispatchAuthorizationSha256,
        progress.startedAt,
        null,
        "running",
        progress.requests.map((entry) =>
          entry.xpRequestID === xpRequestID
            ? {
                ...entry,
                status: "terminal",
                terminalAt,
                terminalReadbackSha256: terminalBody.rawReadbackSha256,
              }
            : entry,
        ),
      );
      await writeDispatchProgress(input.outputDirectory, progress);
      pending.delete(xpRequestID);
    }
    if (pending.size > 0) {
      if (Date.now() >= deadline) {
        throw new Error("confirmatory first-wave terminal wait expired");
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  return progress;
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
      "fenceGitRef",
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
    authorization.fenceGitRef !==
      `refs/tags/commander-xp-dispatch-fence-v2/${sha256Bytes(`${preregistration.experimentID}\n${input.phase}\n${preregistration.identities.adapterSourceSha}\n`)}` ||
    dispatchAuthorizationSha256 !== sha256Canonical(body)
  ) {
    throw new Error("dispatch authorization is invalid");
  }
  return authorization;
}

async function getCommanderXpRecoveryCandidate(
  commandPath: string,
  planned: CommanderXpPlannedRequest,
  xpRequestID: string,
): Promise<CommanderXpRecoveryCandidate> {
  const { stdout } = await execFileAsync(
    commandPath,
    ["xp-request", "get", xpRequestID, "--json"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const detail = JSON.parse(stdout) as Record<string, unknown>;
  if (detail.id !== xpRequestID) {
    throw new Error("Commander XP recovery readback identity is invalid");
  }
  return selectCommanderXpRecoveryCandidate(planned, [
    {
      id: xpRequestID,
      created_at: String(detail.created_at ?? ""),
      status: String(detail.status ?? ""),
      requested: detail.requested,
      rawReadback: stdout,
    },
  ]);
}

async function loadRecoveryState(
  requestedDirectory: string | undefined,
  phase: CommanderXpProtocolPhase,
  expectedRequestCount: number,
  dispatchAuthorizationSha256: string,
  planned: readonly CommanderXpPlannedRequest[],
): Promise<{
  root: string;
  entries: Map<string, CommanderXpDispatchProgressEntry>;
} | null> {
  if (requestedDirectory === undefined) return null;
  const requestedRoot = path.resolve(requestedDirectory);
  const root = await fs.realpath(requestedRoot);
  if (root !== requestedRoot || !(await fs.stat(root)).isDirectory()) {
    throw new Error("Commander XP recovery directory is invalid");
  }
  const progress = JSON.parse(
    await fs.readFile(
      path.join(root, "commander-xp-dispatch-progress-v2.json"),
      "utf8",
    ),
  ) as CommanderXpDispatchProgress;
  exactKeys(
    progress,
    [
      "schemaVersion",
      "authority",
      "phase",
      "expectedRequestCount",
      "dispatchAuthorizationSha256",
      "startedAt",
      "updatedAt",
      "completedAt",
      "status",
      "requests",
      "progressSha256",
    ],
    "recovery progress",
  );
  const { progressSha256, ...body } = progress;
  if (
    progress.schemaVersion !== 2 ||
    progress.authority !== "commander-xp-write-through-dispatch-progress-v2" ||
    progress.phase !== phase ||
    progress.expectedRequestCount !== expectedRequestCount ||
    progress.dispatchAuthorizationSha256 !== dispatchAuthorizationSha256 ||
    !Number.isFinite(Date.parse(progress.startedAt)) ||
    !Number.isFinite(Date.parse(progress.updatedAt)) ||
    !["running", "failed", "completed"].includes(progress.status) ||
    !Array.isArray(progress.requests) ||
    progress.requests.length > expectedRequestCount ||
    progressSha256 !== sha256Canonical(body)
  ) {
    throw new Error("Commander XP recovery progress is invalid");
  }
  const plannedByPath = new Map(
    planned.map((request) => [runDirectory(request), request] as const),
  );
  const entries = new Map<string, CommanderXpDispatchProgressEntry>();
  for (const entry of progress.requests) {
    exactKeys(
      entry,
      [
        "phase",
        "replicaIndex",
        "arm",
        "runPath",
        "requestBodySha256",
        "submittedRequestSha256",
        "wave",
        "status",
        "xpRequestID",
        "rawResponseSha256",
        "rawResponseByteLength",
        "terminalAt",
        "terminalReadbackSha256",
        "failureCode",
      ],
      "recovery progress entry",
    );
    const request = plannedByPath.get(entry.runPath);
    if (
      request === undefined ||
      entries.has(entry.runPath) ||
      entry.phase !== request.phase ||
      entry.replicaIndex !== request.replicaIndex ||
      entry.arm !== request.arm ||
      entry.requestBodySha256 !== request.requestBodySha256 ||
      !/^[0-9a-f]{64}$/.test(entry.submittedRequestSha256) ||
      entry.wave !==
        (phase === "confirmatory" && request.orderIndex === 1 ? 2 : 1) ||
      !["prepared", "submitted", "terminal", "failed"].includes(entry.status) ||
      !(
        entry.xpRequestID === null ||
        /^xreq_[A-Za-z0-9-]+$/.test(entry.xpRequestID)
      ) ||
      (["submitted", "terminal"].includes(entry.status) &&
        entry.xpRequestID === null) ||
      (entry.status === "terminal" &&
        (!Number.isFinite(Date.parse(String(entry.terminalAt))) ||
          !/^[0-9a-f]{64}$/.test(String(entry.terminalReadbackSha256))))
    ) {
      throw new Error("Commander XP recovery progress entry is invalid");
    }
    entries.set(entry.runPath, entry);
  }
  const dispatchOrder =
    phase === "confirmatory"
      ? [
          ...planned.filter((request) => request.orderIndex === 0),
          ...planned.filter((request) => request.orderIndex === 1),
        ]
      : [...planned];
  if (
    progress.requests.some(
      (entry, index) => entry.runPath !== runDirectory(dispatchOrder[index]!),
    )
  ) {
    throw new Error("Commander XP recovery progress is not an exact prefix");
  }
  return { root, entries };
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

async function readOpenApiContract(
  requestedPath: string,
  preregistration: CommanderXpPreRegistrationV2,
): Promise<CommanderXpOpenApiContract> {
  const receipt =
    await readJsonDocument<CommanderXpOpenApiContract>(requestedPath);
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "authority",
      "url",
      "fetchedAt",
      "byteLength",
      "rawSha256",
      "coworldClientVersion",
      "createRequestSchema",
      "rosterSchemas",
      "receiptSha256",
    ],
    "XP OpenAPI contract",
  );
  exactKeys(
    receipt.createRequestSchema,
    ["name", "encoding", "sha256"],
    "XP OpenAPI create schema",
  );
  exactKeys(
    receipt.rosterSchemas,
    ["names", "encoding", "sha256"],
    "XP OpenAPI roster schemas",
  );
  const { receiptSha256, ...body } = receipt;
  if (
    receipt.schemaVersion !== 2 ||
    receipt.authority !== "softmax-public-openapi-exact-bytes-v1" ||
    receipt.url !== "https://softmax.com/api/observatory/openapi.json" ||
    !Number.isFinite(Date.parse(receipt.fetchedAt)) ||
    receipt.byteLength !== 418_415 ||
    receipt.rawSha256 !== COMMANDER_XP_OPENAPI_SHA256 ||
    receipt.rawSha256 !== preregistration.identities.xpOpenApiSha256 ||
    receipt.coworldClientVersion !== "0.1.42" ||
    receipt.createRequestSchema.name !== "V2CreateExperienceRequestRequest" ||
    receipt.createRequestSchema.encoding !==
      "jq-cS-utf8-compact-sorted-json-with-terminal-lf" ||
    receipt.createRequestSchema.sha256 !==
      COMMANDER_XP_CREATE_REQUEST_SCHEMA_SHA256 ||
    receipt.createRequestSchema.sha256 !==
      preregistration.identities.xpCreateRequestSchemaSha256 ||
    JSON.stringify(receipt.rosterSchemas.names) !==
      JSON.stringify(["V2RosterParticipant", "V2RosterPlayer"]) ||
    receipt.rosterSchemas.encoding !==
      "ordered-concatenation-of-two-jq-cS-utf8-records-with-terminal-lf" ||
    receipt.rosterSchemas.sha256 !== COMMANDER_XP_ROSTER_SCHEMAS_SHA256 ||
    receipt.rosterSchemas.sha256 !==
      preregistration.identities.xpRosterSchemasSha256 ||
    receiptSha256 !== sha256Canonical(body)
  ) {
    throw new Error("XP OpenAPI contract identity mismatch");
  }
  return receipt;
}

async function fetchLiveOpenApiIdentity(): Promise<{
  checkedAt: string;
  byteLength: number;
  rawSha256: string;
}> {
  const response = await fetch(
    "https://softmax.com/api/observatory/openapi.json",
    { redirect: "follow", signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    throw new Error("Commander XP live OpenAPI request failed");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("Commander XP live OpenAPI response is oversized");
  }
  return {
    checkedAt: new Date().toISOString(),
    byteLength: bytes.byteLength,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
  };
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

function buildProgress(
  phase: CommanderXpProtocolPhase,
  expectedRequestCount: number,
  dispatchAuthorizationSha256: string,
  startedAt: string,
  completedAt: string | null,
  status: CommanderXpDispatchProgress["status"],
  requests: CommanderXpDispatchProgressEntry[],
): CommanderXpDispatchProgress {
  const body = {
    schemaVersion: 2 as const,
    authority: "commander-xp-write-through-dispatch-progress-v2" as const,
    phase,
    expectedRequestCount,
    dispatchAuthorizationSha256,
    startedAt,
    updatedAt: completedAt ?? new Date().toISOString(),
    completedAt,
    status,
    requests,
  };
  return { ...body, progressSha256: sha256Canonical(body) };
}

async function failDispatchProgress(
  outputDirectory: string,
  progress: CommanderXpDispatchProgress,
  failureCode: string,
  stdout: string,
): Promise<CommanderXpDispatchProgress> {
  const failedAt = new Date().toISOString();
  const failed = buildProgress(
    progress.phase,
    progress.expectedRequestCount,
    progress.dispatchAuthorizationSha256,
    progress.startedAt,
    failedAt,
    "failed",
    [
      ...progress.requests.slice(0, -1),
      {
        ...progress.requests.at(-1)!,
        status: "failed",
        rawResponseSha256: sha256Bytes(stdout),
        rawResponseByteLength: Buffer.byteLength(stdout),
        failureCode,
      },
    ],
  );
  await writeDispatchProgress(outputDirectory, failed);
  return failed;
}

async function writeDispatchProgress(
  outputDirectory: string,
  progress: CommanderXpDispatchProgress,
  exclusive = false,
): Promise<void> {
  const target = path.join(
    outputDirectory,
    "commander-xp-dispatch-progress-v2.json",
  );
  if (exclusive) {
    await writeJsonExclusive(target, progress);
    return;
  }
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, {
    flag: "wx",
  });
  await fs.rename(temporary, target);
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

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  await fs.rename(temporary, target);
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
