import { randomBytes } from "node:crypto";
import { proxyWarPublicRunArtifacts } from "../agents/ProxyWarPublicArtifacts";
import {
  REQUIRED_PREMIERE_LEAK_SURFACES,
  type HashedPremiereEligibility,
  type PolicyIdentity,
  type PremiereEligibility,
  type PremiereExternalEmbargoEvidence,
  type PremiereLeakAuditManifest,
  type PremiereLeakAuditTarget,
  type PremiereLeakCheckEvidence,
  type PremiereLeakSurface,
  type PremiereSeatIdentity,
} from "./ReplayPremiereContracts";
import {
  ReplayPremiereError,
  type ReplayPremierePublicFailure,
} from "./ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  isSha256Hex,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";

const opaqueSourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export interface PremiereEligibilityAssessmentOptions {
  now: Date;
  maxLeakCheckAgeMs: number;
  maxExternalEvidenceAgeMs: number;
  maxObservedBodyBytes: number;
  privateCommitmentNonce: Uint8Array;
  maxFutureClockSkewMs?: number;
}

export interface PremiereLeakAuditFailure {
  checkId: string | null;
  surface: PremiereLeakSurface | null;
  operatorCode: string;
}

export interface PremiereLeakAuditResult {
  schemaVersion: 1;
  status: "passed" | "failed";
  checkedAt: string;
  manifestId: string;
  manifestHash: string;
  evidenceHash: string;
  failures: PremiereLeakAuditFailure[];
  publicFailure: ReplayPremierePublicFailure | null;
}

export interface PremiereEligibilityAssessment {
  eligible: boolean;
  eligibilityRecordHash: string;
  leakAudit: PremiereLeakAuditResult;
  operatorFailureCodes: string[];
  publicFailure: ReplayPremierePublicFailure | null;
}

export interface BuildRequiredLeakAuditManifestOptions {
  origin: string;
  sourceRunId: string;
  createdAt: string;
  /**
   * Selects which bound identities become forbidden leak fingerprints.
   * "controlled_exhibition" (the default) binds every identity including seat
   * display names and game ids. "rated_coworld" binds only episode-scoped
   * identities (run id, hashes, result source id, Coworld episode id, seat
   * client ids): league player display names and the constant adapter game id
   * are legitimately public on the league surfaces and would make every rated
   * admission fail on non-spoiler content.
   */
  sourceKind?: "controlled_exhibition" | "rated_coworld";
  fingerprintBinding: {
    sourceReplaySha256: string;
    authoritativeResultSha256: string;
    authoritativeResultSourceId: string;
    gameIds: string[];
    seatIds: string[];
    seatDisplayNames: string[];
    /** Required when sourceKind is "rated_coworld". */
    coworldEpisodeId?: string;
  };
  alternateUrls?: string[];
}

/**
 * Freezes the precise URLs that must be inspected. Surface labels alone are
 * never treated as evidence of coverage.
 */
export function buildRequiredProxyWarLeakAuditManifest(
  options: BuildRequiredLeakAuditManifestOptions,
): PremiereLeakAuditManifest {
  if (!isOpaqueSourceId(options.sourceRunId)) {
    throw invalidRequest("invalid_source_run_id");
  }
  assertCanonicalTimestamp(options.createdAt, "manifest createdAt");
  const origin = normalizeOrigin(options.origin);
  const encodedRunId = encodeURIComponent(options.sourceRunId);
  const forbiddenText = deriveBoundLeakFingerprints(options);
  if (
    forbiddenText.length < 2 ||
    forbiddenText.some(
      (value) => !isDisplayText(value, 512) || value.trim().length < 4,
    )
  ) {
    throw invalidRequest("insufficient_forbidden_leak_fingerprints");
  }
  const statusHidden = {
    kind: "status" as const,
    allowedHttpStatuses: [403, 404],
    forbiddenText,
  };
  const bodyAbsent = {
    kind: "body_absent" as const,
    requiredHttpStatus: 200,
    forbiddenText,
  };
  const targets: PremiereLeakAuditTarget[] = [
    target("league-page", "league_page", `${origin}/league`, bodyAbsent),
    target(
      "league-data",
      "league_data",
      `${origin}/ai-league-runs/league/data.json`,
      {
        kind: "structured_absent",
        requiredHttpStatus: 200,
        forbiddenText,
      },
    ),
    target(
      "battle-card-data",
      "battle_card",
      `${origin}/ai-league-runs/league/data.json`,
      {
        kind: "structured_absent",
        requiredHttpStatus: 200,
        forbiddenText,
      },
    ),
    target(
      "public-replay-route",
      "public_replay_allowlist",
      `${origin}/ai-league-replay/${encodedRunId}`,
      statusHidden,
    ),
    target(
      "public-artifact-root",
      "public_artifact_allowlist",
      `${origin}/ai-league-runs/${encodedRunId}/`,
      statusHidden,
    ),
    target(
      "game-record-route",
      "game_record_route",
      `${origin}/ai-league-runs/${encodedRunId}/game-record.json`,
      statusHidden,
    ),
    target(
      "match-summary-route",
      "match_summary_route",
      `${origin}/ai-league-runs/${encodedRunId}/match-summary.json`,
      statusHidden,
    ),
    target(
      "result-route",
      "result_route",
      `${origin}/ai-league-runs/${encodedRunId}/result.json`,
      statusHidden,
    ),
    target(
      "decision-tail-route",
      "decision_tail_route",
      `${origin}/ai-league-runs/${encodedRunId}/decision-tail.json`,
      statusHidden,
    ),
    target(
      "diagnostics-route",
      "diagnostics_route",
      `${origin}/ai-league-runs/${encodedRunId}/diagnostics.json`,
      statusHidden,
    ),
    target(
      "social-metadata-route",
      "social_metadata",
      `${origin}/ai-league-replay/${encodedRunId}?premiere_metadata_probe=1`,
      statusHidden,
    ),
    target(
      "direct-source-watch",
      "direct_source_watch_route",
      `${origin}/ai-league-runs/${encodedRunId}/spectator.html`,
      statusHidden,
    ),
    target(
      "cache-source-watch",
      "browser_or_cdn_cache",
      `${origin}/ai-league-runs/${encodedRunId}/spectator.html`,
      {
        kind: "not_cached",
        allowedHttpStatuses: [403, 404],
        forbiddenText,
      },
    ),
  ];
  for (const artifact of proxyWarPublicRunArtifacts) {
    const safeCheckId = artifact.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const directUrl = `${origin}/ai-league-runs/${encodedRunId}/${artifact}`;
    const aliasUrl = `${origin}/ai-league-runs/league-${encodedRunId}/${artifact}`;
    targets.push(
      target(
        `artifact-direct-${safeCheckId}`,
        "public_artifact_allowlist",
        directUrl,
        statusHidden,
      ),
      target(
        `artifact-alias-${safeCheckId}`,
        "public_artifact_allowlist",
        aliasUrl,
        statusHidden,
      ),
      target(
        `artifact-cache-direct-${safeCheckId}`,
        "browser_or_cdn_cache",
        directUrl,
        {
          kind: "not_cached",
          allowedHttpStatuses: [403, 404],
          forbiddenText,
        },
      ),
      target(
        `artifact-cache-alias-${safeCheckId}`,
        "browser_or_cdn_cache",
        aliasUrl,
        {
          kind: "not_cached",
          allowedHttpStatuses: [403, 404],
          forbiddenText,
        },
      ),
    );
  }
  const alternateUrls = [
    `${origin}/proxywar-replay/${encodedRunId}`,
    `${origin}/ai-league-runs/${encodedRunId}`,
    ...(options.alternateUrls ?? []),
  ];
  for (const [index, url] of [...new Set(alternateUrls)].entries()) {
    const normalizedUrl = normalizeAuditUrl(url, origin);
    targets.push(
      target(
        `alternate-source-url-${index}`,
        "alternate_source_url",
        normalizedUrl,
        statusHidden,
      ),
    );
  }
  const manifestWithoutId: Omit<PremiereLeakAuditManifest, "manifestId"> = {
    schemaVersion: 1,
    sourceRunId: options.sourceRunId,
    createdAt: options.createdAt,
    targets,
  };
  return {
    ...manifestWithoutId,
    manifestId: manifestIdFor(manifestWithoutId),
  };
}

export function createPrivateEligibilityCommitmentNonce(
  byteLength = 32,
): Buffer {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw invalidRequest("invalid_commitment_nonce_length");
  }
  return randomBytes(byteLength);
}

export function computeEligibilityRecordCommitment(
  record: PremiereEligibility,
  privateCommitmentNonce: Uint8Array,
): string {
  assertPrivateCommitmentNonce(privateCommitmentNonce);
  const value = eligibilityRecordAsJson(record);
  const domain = Buffer.from("proxywar-premiere-eligibility-v1\0", "utf8");
  const json = Buffer.from(canonicalReplayPremiereJson(value), "utf8");
  return sha256Hex(
    Buffer.concat([
      domain,
      Buffer.from(privateCommitmentNonce),
      Buffer.from("\0", "utf8"),
      json,
    ]),
  );
}

export function assessPremiereLeakAudit(
  manifest: PremiereLeakAuditManifest,
  evidence: PremiereLeakCheckEvidence[],
  options: PremiereEligibilityAssessmentOptions,
): PremiereLeakAuditResult {
  validateAssessmentOptions(options);
  const failures: PremiereLeakAuditFailure[] = [];
  const validTargets = validateLeakAuditManifest(manifest, failures);
  const evidenceByCheckId = new Map<string, PremiereLeakCheckEvidence[]>();
  for (const observation of evidence) {
    const grouped = evidenceByCheckId.get(observation.checkId) ?? [];
    grouped.push(observation);
    evidenceByCheckId.set(observation.checkId, grouped);
  }
  for (const checkId of evidenceByCheckId.keys()) {
    if (!validTargets.has(checkId)) {
      failures.push({
        checkId,
        surface: null,
        operatorCode: "unexpected_leak_check_observation",
      });
    }
  }
  for (const targetDefinition of manifest.targets) {
    const observations = evidenceByCheckId.get(targetDefinition.checkId) ?? [];
    if (observations.length !== 1) {
      failures.push({
        checkId: targetDefinition.checkId,
        surface: targetDefinition.surface,
        operatorCode:
          observations.length === 0
            ? "missing_leak_check_observation"
            : "duplicate_leak_check_observation",
      });
      continue;
    }
    validateLeakObservation(
      targetDefinition,
      observations[0],
      options,
      failures,
    );
  }
  const manifestValue: unknown = manifest;
  const evidenceValue: unknown = evidence;
  assertReplayPremiereJsonValue(manifestValue, "leak audit manifest");
  assertReplayPremiereJsonValue(evidenceValue, "leak audit evidence");
  return {
    schemaVersion: 1,
    status: failures.length === 0 ? "passed" : "failed",
    checkedAt: options.now.toISOString(),
    manifestId: manifest.manifestId,
    manifestHash: hashReplayPremiereJson(manifestValue),
    evidenceHash: hashReplayPremiereJson(evidenceValue),
    failures,
    publicFailure:
      failures.length === 0
        ? null
        : { error: { code: "PREMIERE_SOURCE_INELIGIBLE" } },
  };
}

export function assessPremiereEligibility(
  record: PremiereEligibility,
  options: PremiereEligibilityAssessmentOptions,
): PremiereEligibilityAssessment {
  validateAssessmentOptions(options);
  const eligibilityRecordHash = computeEligibilityRecordCommitment(
    record,
    options.privateCommitmentNonce,
  );
  const leakAudit = assessPremiereLeakAudit(
    record.proxyWarLeakAuditManifest,
    Array.isArray(record.proxyWarLeakChecks) ? record.proxyWarLeakChecks : [],
    options,
  );
  const operatorFailureCodes = validateEligibilityRecord(record, options);
  operatorFailureCodes.push(
    ...leakAudit.failures.map((failure) => failure.operatorCode),
  );
  const uniqueFailureCodes = [...new Set(operatorFailureCodes)];
  return {
    eligible: uniqueFailureCodes.length === 0,
    eligibilityRecordHash,
    leakAudit,
    operatorFailureCodes: uniqueFailureCodes,
    publicFailure:
      uniqueFailureCodes.length === 0
        ? null
        : { error: { code: "PREMIERE_SOURCE_INELIGIBLE" } },
  };
}

export function createHashedPremiereEligibility(
  record: PremiereEligibility,
  options: PremiereEligibilityAssessmentOptions,
): HashedPremiereEligibility {
  const assessment = assessPremiereEligibility(record, options);
  if (!assessment.eligible) {
    throw new ReplayPremiereError(
      "premiere_source_ineligible",
      "PREMIERE_SOURCE_INELIGIBLE",
      422,
      `Premiere source is ineligible: ${assessment.operatorFailureCodes.join(",")}`,
    );
  }
  return {
    record,
    eligibilityRecordHash: assessment.eligibilityRecordHash,
  };
}

function validateLeakAuditManifest(
  manifest: PremiereLeakAuditManifest,
  failures: PremiereLeakAuditFailure[],
): Map<string, PremiereLeakAuditTarget> {
  const targets = new Map<string, PremiereLeakAuditTarget>();
  const expectedManifestId = manifestIdFor({
    schemaVersion: manifest.schemaVersion,
    sourceRunId: manifest.sourceRunId,
    createdAt: manifest.createdAt,
    targets: manifest.targets,
  });
  if (
    manifest.schemaVersion !== 1 ||
    manifest.manifestId !== expectedManifestId ||
    !isOpaqueSourceId(manifest.sourceRunId) ||
    assertCanonicalTimestampOrNull(manifest.createdAt) === null
  ) {
    failures.push({
      checkId: null,
      surface: null,
      operatorCode: "invalid_leak_audit_manifest",
    });
  }
  const coveredSurfaces = new Set<PremiereLeakSurface>();
  for (const definition of manifest.targets) {
    coveredSurfaces.add(definition.surface);
    if (
      !isSafeToken(definition.checkId) ||
      targets.has(definition.checkId) ||
      !isDisplayText(definition.target, 2_048) ||
      (definition.method !== "GET" && definition.method !== "HEAD") ||
      !isValidExpectation(definition)
    ) {
      failures.push({
        checkId: definition.checkId,
        surface: definition.surface,
        operatorCode: "invalid_leak_audit_target",
      });
    }
    targets.set(definition.checkId, definition);
  }
  for (const surface of REQUIRED_PREMIERE_LEAK_SURFACES) {
    if (!coveredSurfaces.has(surface)) {
      failures.push({
        checkId: null,
        surface,
        operatorCode: "leak_manifest_missing_surface",
      });
    }
  }
  return targets;
}

function validateLeakObservation(
  definition: PremiereLeakAuditTarget,
  observation: PremiereLeakCheckEvidence,
  options: PremiereEligibilityAssessmentOptions,
  failures: PremiereLeakAuditFailure[],
): void {
  const fail = (operatorCode: string): void => {
    failures.push({
      checkId: definition.checkId,
      surface: definition.surface,
      operatorCode,
    });
  };
  if (
    observation.target !== definition.target ||
    observation.method !== definition.method
  ) {
    fail("leak_observation_target_mismatch");
  }
  const checkedAtMs = assertCanonicalTimestampOrNull(observation.checkedAt);
  const maxFutureClockSkewMs = options.maxFutureClockSkewMs ?? 300_000;
  if (checkedAtMs === null) fail("leak_check_invalid_timestamp");
  else if (checkedAtMs < options.now.getTime() - options.maxLeakCheckAgeMs) {
    fail("leak_check_stale");
  } else if (checkedAtMs > options.now.getTime() + maxFutureClockSkewMs) {
    fail("leak_check_from_future");
  }
  if (!isSafeToken(observation.checkerVersion)) {
    fail("leak_check_invalid_checker_version");
  }
  const body = observation.observedBodyText;
  if (body === null) {
    fail("leak_check_missing_inspectable_body");
    if (observation.observedContentHash !== null)
      fail("leak_check_body_hash_without_body");
  } else {
    if (Buffer.byteLength(body, "utf8") > options.maxObservedBodyBytes) {
      fail("leak_check_body_ceiling_exceeded");
    }
    if (sha256Hex(body) !== observation.observedContentHash) {
      fail("leak_check_body_hash_mismatch");
    }
  }
  const status = observation.observedHttpStatus;
  if (!isHttpStatus(status)) {
    fail("leak_check_invalid_http_status");
    return;
  }
  const expectation = definition.expectation;
  const headerText = [
    observation.observedHeaders.age,
    observation.observedHeaders.cacheControl,
    observation.observedHeaders.cdnCacheStatus,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
  if (
    [
      observation.observedHeaders.age,
      observation.observedHeaders.cacheControl,
      observation.observedHeaders.cdnCacheStatus,
    ].some((value) => value !== null && typeof value !== "string") ||
    Buffer.byteLength(headerText, "utf8") >
      Math.min(options.maxObservedBodyBytes, 65_536)
  ) {
    fail("leak_check_header_ceiling_or_contract_exceeded");
  }
  if (
    (body !== null && containsForbiddenText(body, expectation.forbiddenText)) ||
    containsForbiddenText(headerText, expectation.forbiddenText)
  ) {
    fail("leak_check_forbidden_response_fingerprint");
  }
  if (expectation.kind === "status") {
    if (!expectation.allowedHttpStatuses.includes(status)) {
      fail("leak_check_exposed_status");
    }
    return;
  }
  if (expectation.kind === "body_absent") {
    if (status !== expectation.requiredHttpStatus || body === null) {
      fail("leak_check_missing_inspectable_body");
    } else if (containsForbiddenText(body, expectation.forbiddenText)) {
      fail("leak_check_forbidden_body_content");
    }
    return;
  }
  if (expectation.kind === "structured_absent") {
    if (status !== expectation.requiredHttpStatus || body === null) {
      fail("leak_check_missing_structured_body");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
      assertReplayPremiereJsonValue(parsed, "structured leak audit body");
    } catch {
      fail("leak_check_invalid_structured_body");
      return;
    }
    if (containsExactStructuredIdentity(parsed, expectation.forbiddenText)) {
      fail("leak_check_structured_source_entry_present");
    }
    return;
  }
  if (!expectation.allowedHttpStatuses.includes(status)) {
    fail("leak_check_cached_exposure_status");
  }
  if (body !== null && containsForbiddenText(body, expectation.forbiddenText)) {
    fail("leak_check_cached_forbidden_content");
  }
  const cacheStatus = observation.observedHeaders.cdnCacheStatus?.toUpperCase();
  const age = observation.observedHeaders.age;
  if (
    (cacheStatus !== undefined &&
      cacheStatus !== null &&
      /HIT|STALE|REVALIDATED/.test(cacheStatus)) ||
    (age !== null && age !== "0")
  ) {
    fail("leak_check_response_was_cached");
  }
}

function validateEligibilityRecord(
  record: PremiereEligibility,
  options: PremiereEligibilityAssessmentOptions,
): string[] {
  const failures: string[] = [];
  if (record.schemaVersion !== 1) failures.push("invalid_schema_version");
  if (!isSafeToken(record.eligibilityCheckVersion)) {
    failures.push("invalid_eligibility_check_version");
  }
  const createdAtMs = assertCanonicalTimestampOrNull(record.createdAt);
  const maxFutureClockSkewMs = options.maxFutureClockSkewMs ?? 300_000;
  if (createdAtMs === null) failures.push("invalid_eligibility_created_at");
  else if (createdAtMs > options.now.getTime() + maxFutureClockSkewMs) {
    failures.push("eligibility_created_in_future");
  }
  if (!isOpaqueSourceId(record.sourceRunId)) {
    failures.push("invalid_source_run_id");
  }
  if (record.proxyWarLeakAuditManifest.sourceRunId !== record.sourceRunId) {
    failures.push("leak_manifest_source_mismatch");
  }
  if (!isSha256Hex(record.sourceReplaySha256)) {
    failures.push("invalid_source_replay_hash");
  }
  if (record.sourceBundleOutsideServedRoots !== true) {
    failures.push("source_bundle_not_private");
  }
  validateCoworldBinding(record, failures);
  validateResultReference(record, failures);
  validateSeats(record.seats, failures);
  validateExternalEmbargo(record, options, failures);
  if (
    record.externalOutcomeMayBePublic &&
    record.publicLabel !== "spoiler_resistant_premiere"
  ) {
    failures.push("public_outcome_requires_spoiler_resistant_label");
  }
  return failures;
}

function validateCoworldBinding(
  record: PremiereEligibility,
  failures: string[],
): void {
  if (record.sourceKind === "rated_coworld") {
    if (record.coworld === null) {
      failures.push("rated_source_missing_coworld_ids");
      return;
    }
    if (
      [
        record.coworld.episodeId,
        record.coworld.leagueId,
        record.coworld.divisionId,
        record.coworld.roundId,
      ].some((value) => !isOpaqueSourceId(value))
    ) {
      failures.push("rated_source_invalid_coworld_id");
    }
  } else if (record.sourceKind === "controlled_exhibition") {
    if (record.coworld !== null)
      failures.push("controlled_source_has_coworld_ids");
  } else {
    failures.push("invalid_source_kind");
  }
}

function validateResultReference(
  record: PremiereEligibility,
  failures: string[],
): void {
  const expectedKind =
    record.sourceKind === "rated_coworld"
      ? "coworld_result"
      : "controlled_result";
  if (record.authoritativeResult.sourceKind !== expectedKind) {
    failures.push("authoritative_result_source_mismatch");
  }
  if (!isOpaqueSourceId(record.authoritativeResult.sourceId)) {
    failures.push("invalid_authoritative_result_source_id");
  }
  if (!isSha256Hex(record.authoritativeResult.resultHash)) {
    failures.push("invalid_authoritative_result_hash");
  }
}

function validateSeats(
  seats: PremiereSeatIdentity[],
  failures: string[],
): void {
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 64) {
    failures.push("invalid_seat_count");
    return;
  }
  const seenSeatIds = new Set<string>();
  for (const seat of seats) {
    if (!isOpaqueSourceId(seat.seatId) || seenSeatIds.has(seat.seatId)) {
      failures.push("invalid_or_duplicate_seat_id");
    }
    seenSeatIds.add(seat.seatId);
    if (!isDisplayText(seat.displayName)) {
      failures.push("invalid_seat_display_name");
    }
    validatePolicyIdentity(seat.policyIdentity, failures);
  }
}

function validatePolicyIdentity(
  identity: PolicyIdentity,
  failures: string[],
): void {
  if (identity.namespace === "softmax_policy_version") {
    if (
      !isOpaqueSourceId(identity.policyVersionId) ||
      !isDisplayText(identity.policyName) ||
      !isSafeToken(identity.serverAssignedVersion)
    ) {
      failures.push("invalid_softmax_policy_identity");
    }
  } else if (identity.namespace === "local_manifest") {
    if (
      !isDisplayText(identity.manifestName) ||
      !isSafeToken(identity.declaredVersion) ||
      !isSha256Hex(identity.manifestSha256) ||
      !isSha256Hex(identity.contentSha256)
    ) {
      failures.push("invalid_local_manifest_identity");
    }
  } else {
    failures.push("invalid_policy_identity_namespace");
  }
}

function validateExternalEmbargo(
  record: PremiereEligibility,
  options: PremiereEligibilityAssessmentOptions,
  failures: string[],
): void {
  for (const evidence of record.externalEmbargoEvidence) {
    validateExternalEvidence(evidence, options, failures);
  }
  if (
    record.publicLabel === "premiere" &&
    (record.externalOutcomeMayBePublic ||
      record.externalEmbargoEvidence.length === 0 ||
      record.externalEmbargoEvidence.some(
        (evidence) => !evidence.embargoConfirmed,
      ))
  ) {
    failures.push("premiere_label_requires_external_embargo");
  }
}

function validateExternalEvidence(
  evidence: PremiereExternalEmbargoEvidence,
  options: PremiereEligibilityAssessmentOptions,
  failures: string[],
): void {
  if (
    !isDisplayText(evidence.source) ||
    !isDisplayText(evidence.scope) ||
    !isDisplayText(evidence.verifier)
  ) {
    failures.push("invalid_external_embargo_evidence");
  }
  const observedAtMs = assertCanonicalTimestampOrNull(evidence.observedAt);
  const maxFutureClockSkewMs = options.maxFutureClockSkewMs ?? 300_000;
  if (observedAtMs === null)
    failures.push("external_embargo_invalid_timestamp");
  else if (
    observedAtMs <
    options.now.getTime() - options.maxExternalEvidenceAgeMs
  ) {
    failures.push("external_embargo_stale");
  } else if (observedAtMs > options.now.getTime() + maxFutureClockSkewMs) {
    failures.push("external_embargo_from_future");
  }
}

function isValidExpectation(definition: PremiereLeakAuditTarget): boolean {
  const expectation = definition.expectation;
  if (expectation.kind === "status") {
    return (
      expectation.allowedHttpStatuses.length > 0 &&
      expectation.allowedHttpStatuses.every(isHttpStatus) &&
      validForbiddenText(expectation.forbiddenText)
    );
  }
  if (expectation.kind === "body_absent") {
    return (
      definition.method === "GET" &&
      isHttpStatus(expectation.requiredHttpStatus) &&
      validForbiddenText(expectation.forbiddenText)
    );
  }
  if (expectation.kind === "structured_absent") {
    return (
      definition.method === "GET" &&
      isHttpStatus(expectation.requiredHttpStatus) &&
      validForbiddenText(expectation.forbiddenText)
    );
  }
  return (
    expectation.allowedHttpStatuses.length > 0 &&
    expectation.allowedHttpStatuses.every(isHttpStatus) &&
    validForbiddenText(expectation.forbiddenText)
  );
}

function validForbiddenText(values: string[]): boolean {
  return (
    values.length >= 2 &&
    values.every((value) => isDisplayText(value, 512) && value.length >= 4)
  );
}

function containsForbiddenText(body: string, forbiddenText: string[]): boolean {
  const normalizedBody = body.toLocaleLowerCase("en-US");
  return forbiddenText.some((needle) =>
    normalizedBody.includes(needle.toLocaleLowerCase("en-US")),
  );
}

function containsExactStructuredIdentity(
  value: unknown,
  identities: readonly string[],
): boolean {
  if (typeof value === "string") return identities.includes(value);
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsExactStructuredIdentity(entry, identities),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsExactStructuredIdentity(entry, identities),
    );
  }
  return false;
}

function deriveBoundLeakFingerprints(
  options: BuildRequiredLeakAuditManifestOptions,
): string[] {
  const binding = options.fingerprintBinding;
  const sourceKind = options.sourceKind ?? "controlled_exhibition";
  if (
    !isSha256Hex(binding.sourceReplaySha256) ||
    !isSha256Hex(binding.authoritativeResultSha256) ||
    !Array.isArray(binding.gameIds) ||
    binding.gameIds.length === 0 ||
    !Array.isArray(binding.seatIds) ||
    binding.seatIds.length < 2 ||
    !Array.isArray(binding.seatDisplayNames) ||
    binding.seatDisplayNames.length !== binding.seatIds.length ||
    (sourceKind === "rated_coworld" &&
      !isOpaqueSourceId(binding.coworldEpisodeId))
  ) {
    throw invalidRequest("invalid_leak_fingerprint_binding");
  }
  const values =
    sourceKind === "rated_coworld"
      ? [
          options.sourceRunId,
          binding.sourceReplaySha256,
          binding.authoritativeResultSha256,
          binding.authoritativeResultSourceId,
          String(binding.coworldEpisodeId),
          ...binding.seatIds,
        ]
      : [
          options.sourceRunId,
          binding.sourceReplaySha256,
          binding.authoritativeResultSha256,
          binding.authoritativeResultSourceId,
          ...binding.gameIds,
          ...binding.seatIds,
          ...binding.seatDisplayNames,
        ];
  if (
    values.some(
      (value) => !isDisplayText(value, 512) || value.trim().length < 4,
    )
  ) {
    throw invalidRequest("invalid_leak_fingerprint_identity");
  }
  return [...new Set(values)];
}

function target(
  checkId: string,
  surface: PremiereLeakSurface,
  targetUrl: string,
  expectation: PremiereLeakAuditTarget["expectation"],
): PremiereLeakAuditTarget {
  return {
    checkId,
    surface,
    target: targetUrl,
    method: "GET",
    expectation,
  };
}

function manifestIdFor(
  manifest: Omit<PremiereLeakAuditManifest, "manifestId">,
): string {
  const value: unknown = manifest;
  assertReplayPremiereJsonValue(value, "leak audit manifest identity");
  return `leak_${hashReplayPremiereJson(value).slice(0, 24)}`;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalidRequest("invalid_leak_audit_origin", error);
  }
  if (
    (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw invalidRequest("unsafe_leak_audit_origin");
  }
  return parsed.origin;
}

function normalizeAuditUrl(value: string, requiredOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalidRequest("invalid_alternate_audit_url", error);
  }
  if (
    parsed.origin !== requiredOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw invalidRequest("unsafe_alternate_audit_url");
  }
  return parsed.toString();
}

function validateAssessmentOptions(
  options: PremiereEligibilityAssessmentOptions,
): void {
  for (const [name, value] of [
    ["maxLeakCheckAgeMs", options.maxLeakCheckAgeMs],
    ["maxExternalEvidenceAgeMs", options.maxExternalEvidenceAgeMs],
    ["maxObservedBodyBytes", options.maxObservedBodyBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidRequest(`invalid_${name}`);
    }
  }
  assertPrivateCommitmentNonce(options.privateCommitmentNonce);
}

function assertPrivateCommitmentNonce(value: Uint8Array): void {
  if (
    !ArrayBuffer.isView(value) ||
    value.BYTES_PER_ELEMENT !== 1 ||
    value.byteLength < 16 ||
    value.byteLength > 64
  ) {
    throw invalidRequest("invalid_private_commitment_nonce");
  }
}

function isOpaqueSourceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    opaqueSourceIdPattern.test(value) &&
    !value.includes("..")
  );
}

function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && safeTokenPattern.test(value);
}

function isDisplayText(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function isHttpStatus(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
  );
}

function assertCanonicalTimestampOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function assertCanonicalTimestamp(value: string, field: string): number {
  const parsed = assertCanonicalTimestampOrNull(value);
  if (parsed === null) throw invalidRequest(`invalid_${field}_timestamp`);
  return parsed;
}

function invalidRequest(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere eligibility request rejected: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

export function eligibilityRecordAsJson(
  record: PremiereEligibility,
): ReplayPremiereJsonValue {
  const value: unknown = record;
  assertReplayPremiereJsonValue(value, "premiere eligibility record");
  return value;
}
