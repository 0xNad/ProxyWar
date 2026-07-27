import type {
  PremiereEligibility,
  PremiereLeakAuditManifest,
  PremiereLeakAuditTarget,
  PremiereLeakCheckEvidence,
} from "./ReplayPremiereContracts";
import {
  assessPremiereLeakAudit,
  type PremiereEligibilityAssessmentOptions,
} from "./ReplayPremiereEligibility";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";

const issuedLeakAuditReceipts = new WeakSet<object>();
const leakAuditReceiptIssuer = Symbol("replay-premiere-leak-audit-collector");
const CHECKER_VERSION = "premiere-leak-collector/v1-decoded-utf8";

export interface ReplayPremiereLeakAuditCollectorLimits {
  maxTargets: number;
  maxTargetUrlBytes: number;
  maxBodyBytesPerTarget: number;
  maxTotalBodyBytes: number;
  maxHeaderBytesPerTarget: number;
  maxHeaderCountPerTarget: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface ReplayPremiereLeakAuditTransferEvidence {
  checkId: string;
  status: number;
  redirected: false;
  bodyHashScope: "fetch_decoded_utf8";
  decodedBodyBytes: number;
  decodedBodySha256: string;
  rawBodySha256: null;
  wireContentLengthHeader: string | null;
  contentEncodingHeader: string | null;
  inspectedHeaderBytes: number;
}

export interface ReplayPremiereLeakAuditReceiptMaterial {
  schemaVersion: 1;
  receiptKind: "replay_premiere_leak_audit_receipt_v1";
  manifest: PremiereLeakAuditManifest;
  evidence: PremiereLeakCheckEvidence[];
  transfers: ReplayPremiereLeakAuditTransferEvidence[];
  checkedAt: string;
  manifestHash: string;
  evidenceHash: string;
  transferEvidenceHash: string;
}

export interface CollectReplayPremiereLeakAuditOptions {
  manifest: PremiereLeakAuditManifest;
  expectedOrigin: string;
  assessmentOptions: PremiereEligibilityAssessmentOptions;
  limits: ReplayPremiereLeakAuditCollectorLimits;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export class VerifiedReplayPremiereLeakAuditReceipt {
  constructor(
    issuer: typeof leakAuditReceiptIssuer,
    private readonly manifestValue: PremiereLeakAuditManifest,
    private readonly evidenceValue: PremiereLeakCheckEvidence[],
    private readonly transferValue: ReplayPremiereLeakAuditTransferEvidence[],
    readonly checkedAt: string,
    readonly manifestHash: string,
    readonly evidenceHash: string,
    readonly transferEvidenceHash: string,
  ) {
    if (issuer !== leakAuditReceiptIssuer) {
      throw collectorIntegrity("fabricated_leak_audit_receipt");
    }
    issuedLeakAuditReceipts.add(this);
    Object.freeze(this);
  }

  static isAuthentic(
    value: unknown,
  ): value is VerifiedReplayPremiereLeakAuditReceipt {
    return (
      value instanceof VerifiedReplayPremiereLeakAuditReceipt &&
      issuedLeakAuditReceipts.has(value)
    );
  }

  static verifyForEligibility(options: {
    receipt: VerifiedReplayPremiereLeakAuditReceipt;
    eligibilityRecord: PremiereEligibility;
    assessmentOptions: PremiereEligibilityAssessmentOptions;
  }): void {
    if (!this.isAuthentic(options.receipt)) {
      throw collectorIntegrity("fabricated_leak_audit_receipt");
    }
    const record = options.eligibilityRecord;
    const receipt = options.receipt;
    const assessment = assessPremiereLeakAudit(
      record.proxyWarLeakAuditManifest,
      record.proxyWarLeakChecks,
      options.assessmentOptions,
    );
    if (
      assessment.status !== "passed" ||
      receipt.manifestHash !==
        hashReplayPremiereJson(asJson(record.proxyWarLeakAuditManifest)) ||
      receipt.evidenceHash !==
        hashReplayPremiereJson(asJson(record.proxyWarLeakChecks)) ||
      hashReplayPremiereJson(asJson(receipt.manifestValue)) !==
        receipt.manifestHash ||
      hashReplayPremiereJson(asJson(receipt.evidenceValue)) !==
        receipt.evidenceHash ||
      receipt.transferValue.length !== record.proxyWarLeakChecks.length ||
      hashReplayPremiereJson(asJson(receipt.transferValue)) !==
        receipt.transferEvidenceHash ||
      receipt.checkedAt !== assessment.checkedAt
    ) {
      throw collectorIntegrity("leak_audit_receipt_binding_mismatch");
    }
  }

  evidence(): PremiereLeakCheckEvidence[] {
    this.assertAuthentic();
    return immutable(this.evidenceValue, "leak receipt evidence view");
  }

  transfers(): ReplayPremiereLeakAuditTransferEvidence[] {
    this.assertAuthentic();
    return immutable(this.transferValue, "leak receipt transfer view");
  }

  material(): ReplayPremiereLeakAuditReceiptMaterial {
    this.assertAuthentic();
    return immutable(
      {
        schemaVersion: 1,
        receiptKind: "replay_premiere_leak_audit_receipt_v1",
        manifest: this.manifestValue,
        evidence: this.evidenceValue,
        transfers: this.transferValue,
        checkedAt: this.checkedAt,
        manifestHash: this.manifestHash,
        evidenceHash: this.evidenceHash,
        transferEvidenceHash: this.transferEvidenceHash,
      },
      "leak receipt material view",
    );
  }

  private assertAuthentic(): void {
    if (!issuedLeakAuditReceipts.has(this)) {
      throw collectorIntegrity("fabricated_leak_audit_receipt");
    }
  }
}

/**
 * Reissues only from the exact private material originally emitted by this
 * collector. This is a restart verification boundary, not a deserializer for
 * an in-process receipt instance.
 */
export function verifyStoredReplayPremiereLeakAuditReceipt(options: {
  material: ReplayPremiereLeakAuditReceiptMaterial;
  assessmentOptions: PremiereEligibilityAssessmentOptions;
}): VerifiedReplayPremiereLeakAuditReceipt {
  const material = immutable(options.material, "stored leak receipt material");
  assertExactKeys(material as unknown as Record<string, unknown>, [
    "schemaVersion",
    "receiptKind",
    "manifest",
    "evidence",
    "transfers",
    "checkedAt",
    "manifestHash",
    "evidenceHash",
    "transferEvidenceHash",
  ]);
  if (
    material.schemaVersion !== 1 ||
    material.receiptKind !== "replay_premiere_leak_audit_receipt_v1" ||
    !Array.isArray(material.evidence) ||
    !Array.isArray(material.transfers) ||
    material.evidence.length !== material.transfers.length ||
    hashReplayPremiereJson(asJson(material.manifest)) !==
      material.manifestHash ||
    hashReplayPremiereJson(asJson(material.evidence)) !==
      material.evidenceHash ||
    hashReplayPremiereJson(asJson(material.transfers)) !==
      material.transferEvidenceHash
  ) {
    throw collectorIntegrity("stored_leak_audit_receipt_invalid");
  }
  const assessment = assessPremiereLeakAudit(
    material.manifest,
    material.evidence,
    options.assessmentOptions,
  );
  if (
    assessment.status !== "passed" ||
    assessment.checkedAt !== material.checkedAt ||
    material.evidence.some(
      (evidence, index) =>
        !validStoredTransferBinding(evidence, material.transfers[index]),
    )
  ) {
    throw collectorIntegrity("stored_leak_audit_receipt_binding_mismatch");
  }
  return issueVerifiedLeakAuditReceipt({
    manifest: material.manifest,
    evidence: material.evidence,
    transfers: material.transfers,
    checkedAt: material.checkedAt,
  });
}

export async function collectReplayPremiereLeakAudit(
  options: CollectReplayPremiereLeakAuditOptions,
): Promise<VerifiedReplayPremiereLeakAuditReceipt> {
  validateReplayPremiereLeakAuditCollectorLimits(options.limits);
  const expectedOrigin = safeOrigin(options.expectedOrigin);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw collectorUnavailable("fetch_unavailable");
  }
  validateManifestAdmission(options.manifest, expectedOrigin, options.limits);
  const manifestPreflight = assessPremiereLeakAudit(
    options.manifest,
    [],
    options.assessmentOptions,
  );
  if (
    manifestPreflight.failures.some((failure) =>
      [
        "invalid_leak_audit_manifest",
        "invalid_leak_audit_target",
        "leak_manifest_missing_surface",
      ].includes(failure.operatorCode),
    )
  ) {
    throw collectorIneligible("collector_manifest_preflight_failed");
  }

  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(),
    options.limits.totalTimeoutMs,
  );
  const startedAt = Date.now();
  const evidence: PremiereLeakCheckEvidence[] = [];
  const transfers: ReplayPremiereLeakAuditTransferEvidence[] = [];
  let totalBodyBytes = 0;
  try {
    for (const target of options.manifest.targets) {
      if (Date.now() - startedAt >= options.limits.totalTimeoutMs) {
        throw collectorUnavailable("collector_total_timeout");
      }
      const collected = await collectTarget({
        target,
        fetchImplementation,
        controller,
        now: options.now ?? (() => new Date()),
        limits: options.limits,
      });
      totalBodyBytes += collected.transfer.decodedBodyBytes;
      if (totalBodyBytes > options.limits.maxTotalBodyBytes) {
        throw collectorCapacity("collector_total_body_ceiling_exceeded");
      }
      evidence.push(collected.evidence);
      transfers.push(collected.transfer);
    }
  } finally {
    clearTimeout(totalTimer);
  }
  const assessment = assessPremiereLeakAudit(
    options.manifest,
    evidence,
    options.assessmentOptions,
  );
  if (assessment.status !== "passed") {
    throw collectorIneligible("collected_leak_audit_failed");
  }
  return issueVerifiedLeakAuditReceipt({
    manifest: options.manifest,
    evidence,
    transfers,
    checkedAt: assessment.checkedAt,
  });
}

async function collectTarget(options: {
  target: PremiereLeakAuditTarget;
  fetchImplementation: typeof globalThis.fetch;
  controller: AbortController;
  now: () => Date;
  limits: ReplayPremiereLeakAuditCollectorLimits;
}): Promise<{
  evidence: PremiereLeakCheckEvidence;
  transfer: ReplayPremiereLeakAuditTransferEvidence;
}> {
  const requestController = new AbortController();
  const abortRequest = (): void => requestController.abort();
  options.controller.signal.addEventListener("abort", abortRequest, {
    once: true,
  });
  const requestTimer = setTimeout(
    () => requestController.abort(),
    options.limits.requestTimeoutMs,
  );
  try {
    const response = await options.fetchImplementation(options.target.target, {
      method: options.target.method,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json,text/html,text/plain;q=0.9,*/*;q=0.1",
      },
      signal: requestController.signal,
    });
    const responseUrl =
      response.url === "" ? options.target.target : response.url;
    if (
      response.redirected ||
      new URL(responseUrl).origin !== new URL(options.target.target).origin
    ) {
      throw collectorIneligible("collector_redirect_rejected");
    }
    const headerEvidence = inspectHeaders(response.headers, options.limits);
    const declaredLength = boundedContentLength(
      response.headers.get("content-length"),
      options.limits.maxBodyBytesPerTarget,
    );
    const bytes = await readBoundedBody(
      response,
      options.limits.maxBodyBytesPerTarget,
      requestController,
    );
    const contentEncoding = response.headers.get("content-encoding");
    if (
      declaredLength !== null &&
      (contentEncoding === null ||
        contentEncoding.toLowerCase() === "identity") &&
      declaredLength !== bytes.byteLength
    ) {
      throw collectorIneligible("collector_content_length_mismatch");
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw collectorIneligible("collector_body_not_utf8", error);
    }
    const checkedAt = canonicalTimestamp(options.now);
    const decodedBodySha256 = sha256Hex(bytes);
    return {
      evidence: {
        checkId: options.target.checkId,
        target: options.target.target,
        method: options.target.method,
        observedHttpStatus: response.status,
        observedContentHash: sha256Hex(body),
        observedBodyText: body,
        observedHeaders: headerEvidence.observed,
        checkedAt,
        checkerVersion: CHECKER_VERSION,
      },
      transfer: {
        checkId: options.target.checkId,
        status: response.status,
        redirected: false,
        bodyHashScope: "fetch_decoded_utf8",
        decodedBodyBytes: bytes.byteLength,
        decodedBodySha256,
        rawBodySha256: null,
        wireContentLengthHeader: response.headers.get("content-length"),
        contentEncodingHeader: contentEncoding,
        inspectedHeaderBytes: headerEvidence.byteLength,
      },
    };
  } catch (error) {
    if (error instanceof ReplayPremiereError) throw error;
    if (requestController.signal.aborted) {
      throw collectorUnavailable("collector_request_timeout", error);
    }
    throw collectorUnavailable("collector_request_failed", error);
  } finally {
    clearTimeout(requestTimer);
    options.controller.signal.removeEventListener("abort", abortRequest);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw collectorCapacity("collector_body_ceiling_exceeded");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function inspectHeaders(
  headers: Headers,
  limits: ReplayPremiereLeakAuditCollectorLimits,
): {
  observed: PremiereLeakCheckEvidence["observedHeaders"];
  byteLength: number;
} {
  let count = 0;
  let byteLength = 0;
  for (const [name, value] of headers.entries()) {
    count += 1;
    byteLength += Buffer.byteLength(`${name}:${value}\n`, "utf8");
    if (
      count > limits.maxHeaderCountPerTarget ||
      byteLength > limits.maxHeaderBytesPerTarget
    ) {
      throw collectorCapacity("collector_header_ceiling_exceeded");
    }
  }
  return {
    observed: {
      age: headers.get("age"),
      cacheControl: headers.get("cache-control"),
      cdnCacheStatus: headers.get("cf-cache-status") ?? headers.get("x-cache"),
    },
    byteLength,
  };
}

function validateManifestAdmission(
  manifest: PremiereLeakAuditManifest,
  expectedOrigin: string,
  limits: ReplayPremiereLeakAuditCollectorLimits,
): void {
  if (
    !Array.isArray(manifest.targets) ||
    manifest.targets.length === 0 ||
    manifest.targets.length > limits.maxTargets
  ) {
    throw collectorCapacity("collector_target_count_ceiling_exceeded");
  }
  const checkIds = new Set<string>();
  for (const target of manifest.targets) {
    let parsed: URL;
    try {
      parsed = new URL(target.target);
    } catch (error) {
      throw collectorIneligible("collector_invalid_target_url", error);
    }
    if (
      Buffer.byteLength(target.target, "utf8") > limits.maxTargetUrlBytes ||
      parsed.origin !== expectedOrigin ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      target.method !== "GET" ||
      checkIds.has(target.checkId)
    ) {
      throw collectorIneligible("collector_target_not_allowlisted");
    }
    checkIds.add(target.checkId);
  }
}

function safeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw collectorIneligible("collector_invalid_expected_origin", error);
  }
  if (
    (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw collectorIneligible("collector_unsafe_expected_origin");
  }
  return parsed.origin;
}

function boundedContentLength(
  value: string | null,
  maximum: number,
): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw collectorIneligible("collector_invalid_content_length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw collectorCapacity("collector_content_length_ceiling_exceeded");
  }
  return parsed;
}

export function validateReplayPremiereLeakAuditCollectorLimits(
  limits: ReplayPremiereLeakAuditCollectorLimits,
): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw collectorIneligible("collector_invalid_limits");
    }
  }
  if (
    limits.maxTargets > 512 ||
    limits.maxTargetUrlBytes > 8_192 ||
    limits.maxBodyBytesPerTarget > 4 * 1024 * 1024 ||
    limits.maxTotalBodyBytes > 64 * 1024 * 1024 ||
    limits.maxHeaderBytesPerTarget > 64 * 1024 ||
    limits.maxHeaderCountPerTarget > 256 ||
    limits.requestTimeoutMs > 10_000 ||
    limits.totalTimeoutMs > 60_000 ||
    limits.maxTotalBodyBytes < limits.maxBodyBytesPerTarget
  ) {
    throw collectorIneligible("collector_limits_outside_hard_bounds");
  }
}

function canonicalTimestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw collectorUnavailable("collector_invalid_clock");
  }
  return value.toISOString();
}

function issueVerifiedLeakAuditReceipt(options: {
  manifest: PremiereLeakAuditManifest;
  evidence: PremiereLeakCheckEvidence[];
  transfers: ReplayPremiereLeakAuditTransferEvidence[];
  checkedAt: string;
}): VerifiedReplayPremiereLeakAuditReceipt {
  const manifest = immutable(options.manifest, "leak receipt manifest");
  const evidence = immutable(options.evidence, "leak receipt evidence");
  const transfers = immutable(options.transfers, "leak receipt transfers");
  return new VerifiedReplayPremiereLeakAuditReceipt(
    leakAuditReceiptIssuer,
    manifest,
    evidence,
    transfers,
    options.checkedAt,
    hashReplayPremiereJson(asJson(manifest)),
    hashReplayPremiereJson(asJson(evidence)),
    hashReplayPremiereJson(asJson(transfers)),
  );
}

function validStoredTransferBinding(
  evidence: PremiereLeakCheckEvidence,
  transfer: ReplayPremiereLeakAuditTransferEvidence | undefined,
): boolean {
  if (transfer === undefined || evidence.observedBodyText === null)
    return false;
  const bytes = Buffer.from(evidence.observedBodyText, "utf8");
  const contentEncoding = transfer.contentEncodingHeader?.toLowerCase() ?? null;
  const declaredLength = transfer.wireContentLengthHeader;
  return (
    transfer.checkId === evidence.checkId &&
    transfer.status === evidence.observedHttpStatus &&
    transfer.redirected === false &&
    transfer.bodyHashScope === "fetch_decoded_utf8" &&
    transfer.decodedBodyBytes === bytes.byteLength &&
    transfer.decodedBodySha256 === sha256Hex(bytes) &&
    transfer.rawBodySha256 === null &&
    Number.isSafeInteger(transfer.inspectedHeaderBytes) &&
    transfer.inspectedHeaderBytes >= 0 &&
    transfer.inspectedHeaderBytes <= 64 * 1024 &&
    (declaredLength === null || /^(0|[1-9][0-9]*)$/.test(declaredLength)) &&
    (transfer.contentEncodingHeader === null ||
      (transfer.contentEncodingHeader.length > 0 &&
        transfer.contentEncodingHeader.length <= 256)) &&
    (declaredLength === null ||
      (contentEncoding !== null && contentEncoding !== "identity") ||
      Number(declaredLength) === bytes.byteLength)
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw collectorIntegrity("stored_leak_audit_receipt_unknown_fields");
  }
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  const accepted = immutable(value, "leak collector JSON");
  assertReplayPremiereJsonValue(accepted, "leak collector JSON");
  return accepted;
}

function immutable<T>(value: T, source: string): T {
  return cloneAndFreezeReplayPremiereValue(value, source);
}

function collectorIneligible(
  reason: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    `premiere_leak_${reason}`,
    "PREMIERE_SOURCE_INELIGIBLE",
    422,
    "Replay premiere source leak audit failed",
    cause === undefined ? undefined : { cause },
  );
}

function collectorCapacity(reason: string): ReplayPremiereError {
  return new ReplayPremiereError(
    `premiere_leak_${reason}`,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    "Replay premiere leak audit exceeded a fixed capacity limit",
  );
}

function collectorUnavailable(
  reason: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    `premiere_leak_${reason}`,
    "PREMIERE_UNAVAILABLE",
    503,
    "Replay premiere leak audit is unavailable",
    cause === undefined ? undefined : { cause },
  );
}

function collectorIntegrity(reason: string): ReplayPremiereError {
  return new ReplayPremiereError(
    `premiere_leak_${reason}`,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    "Replay premiere leak audit receipt failed integrity verification",
  );
}
