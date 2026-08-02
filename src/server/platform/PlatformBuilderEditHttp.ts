/**
 * `/api/account/builder-profile-edits` — the verified-Builder
 * self-service field-edit API. Same route style, security division of
 * duty, and error shape as `PlatformAccountHttp.ts` (that file is the
 * canonical example this one copies): `security.bootstrapRead`/
 * `authorizeWrite` decide WHO the caller is, this file decides WHAT they
 * may do with that identity, and every response carries
 * `Cache-Control: no-store, max-age=0` plus a `{error:{code}}` body on
 * failure.
 *
 * Every write here lands in `PlatformBuilderEditStore` as a `pending`
 * record — never in the tracked identity registry directly. See that
 * store's module doc for why (untrusted, frequent submissions vs.
 * operator-run, trusted, infrequent `identity:edits publish`).
 */
import express, { type Request, type Response, type Router } from "express";
import {
  AgentProfile,
  AgentVersion,
  BuilderProfile,
} from "../identity/IdentitySchemas";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import {
  EDITABLE_FIELDS_BY_TARGET_KIND,
  findEditsByAccount,
  mutateBuilderEditStore,
  readBuilderEditStore,
  submitEdit,
  BuilderEditValidationError,
  type BuilderEditTargetKind,
} from "./PlatformBuilderEditStore";
import {
  findClaimsByAccount,
  findVerifiedBuilderAccountIds,
  readBuilderClaimStore,
} from "./PlatformBuilderClaimStore";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type { PlatformGithubIdentityLinkStore } from "./PlatformGithubIdentityLinkStore";
import {
  defaultIdentityRegistryDir,
  loadIdentityRegistrySnapshot,
  type IdentityRegistrySnapshot,
} from "../identity/IdentityRegistry";

const MAX_TARGET_ID_BYTES = 256;
const MAX_FIELD_NAME_BYTES = 128;

export interface PlatformBuilderEditHttpOptions {
  readonly security: PlatformAccountSecurity;
  readonly editStore: { readonly stateRoot: string };
  readonly claimStore: { readonly stateRoot: string };
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  readonly identityRegistryDir?: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

function sendFailure(res: Response, status: number, code: string): void {
  res.status(status).json({ error: { code } });
}

/** Same shape as `PlatformAccountHttp.ts`'s own (unexported) helper — deliberately duplicated rather than imported, per this track's file boundary. */
function sendPlatformSecurityFailure(
  res: Response,
  logError: (operatorCode: string, error: unknown) => void,
  operatorCode: string,
  error: unknown,
): void {
  const status =
    typeof error === "object" &&
    error !== null &&
    "httpStatus" in error &&
    (error.httpStatus === 401 || error.httpStatus === 403)
      ? error.httpStatus
      : 503;
  logError(operatorCode, error);
  sendFailure(
    res,
    status,
    status === 503 ? "PLATFORM_UNAVAILABLE" : "PLATFORM_UNAUTHORIZED",
  );
}

interface EditSubmissionBody {
  readonly targetKind: BuilderEditTargetKind;
  readonly targetId: string;
  readonly field: string;
  readonly proposedValue: unknown;
}

function parseSubmissionBody(body: unknown): EditSubmissionBody | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("targetKind" in body) || !("targetId" in body) || !("field" in body) || !("proposedValue" in body)) {
    return null;
  }
  const { targetKind, targetId, field, proposedValue } = body as Record<
    "targetKind" | "targetId" | "field" | "proposedValue",
    unknown
  >;
  if (targetKind !== "builder" && targetKind !== "agent" && targetKind !== "version") {
    return null;
  }
  if (
    typeof targetId !== "string" ||
    targetId.length === 0 ||
    Buffer.byteLength(targetId, "utf8") > MAX_TARGET_ID_BYTES
  ) {
    return null;
  }
  if (
    typeof field !== "string" ||
    field.length === 0 ||
    Buffer.byteLength(field, "utf8") > MAX_FIELD_NAME_BYTES
  ) {
    return null;
  }
  return { targetKind, targetId, field, proposedValue };
}

type EditableRegistryRecord = BuilderProfile | AgentProfile | AgentVersion;

/**
 * The authorization core of the POST route: `targetId` is "the caller's"
 * iff it names a builder the caller controls (via a `verified` claim on
 * one of the builder's agents), OR an agent/version whose OWN `builderId`
 * resolves to a builder the caller controls the same way. `verifiedGithub`
 * is never consulted here — `ownedBuilderIds`, derived straight from the
 * claim store, is the source of truth (see `PlatformBuilderEditStore.ts`'s
 * design-decision doc references for why).
 */
function resolveOwnedTargetRecord(
  snapshot: IdentityRegistrySnapshot,
  ownedBuilderIds: ReadonlySet<string>,
  targetKind: BuilderEditTargetKind,
  targetId: string,
): EditableRegistryRecord | null {
  if (targetKind === "builder") {
    if (!ownedBuilderIds.has(targetId)) return null;
    return snapshot.builders.find((builder) => builder.id === targetId) ?? null;
  }
  if (targetKind === "agent") {
    const agent = snapshot.agents.find((candidate) => candidate.id === targetId);
    if (agent === undefined) return null;
    if (agent.builderId === null || !ownedBuilderIds.has(agent.builderId)) return null;
    return agent;
  }
  const version = snapshot.versions.find((candidate) => candidate.id === targetId);
  if (version === undefined) return null;
  const agent = snapshot.agents.find((candidate) => candidate.id === version.agentId);
  if (agent === undefined || agent.builderId === null || !ownedBuilderIds.has(agent.builderId)) {
    return null;
  }
  return version;
}

export function createPlatformBuilderEditRouter(
  options: PlatformBuilderEditHttpOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(
    "/api/account/builder-profile-edits",
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const bootstrap = options.security.bootstrapRead(
          requestSecurityHeaders(req),
        );
        if (bootstrap.setCookie !== null) {
          res.setHeader("Set-Cookie", bootstrap.setCookie);
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            bootstrap.account.accountId,
          );
        const store = await readBuilderEditStore(options.editStore.stateRoot);
        const edits = findEditsByAccount(store, canonicalAccountId);
        res.status(200).json({ schemaVersion: 1, edits });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_edits_read_failed",
          error,
        );
      }
    },
  );

  /**
   * Submits one field edit as `pending`. Authorization order (each a
   * distinct failure code, checked in this exact order per the shared
   * contract): (a) caller holds >=1 `verified` claim at all; (b) that
   * claim's builder actually owns `targetId`; (c) `field` is in that
   * target kind's editable allowlist. `submitEdit` itself re-checks (c)
   * and additionally validates `proposedValue` against the field's real
   * registry schema piece — a failure there (value present but
   * malformed, e.g. a `displayName` over 80 characters) is reported as
   * `PLATFORM_INVALID_REQUEST`, distinct from `PLATFORM_FIELD_NOT_EDITABLE`
   * (field itself not allowed) since the field WAS on the allowlist.
   */
  router.post(
    "/api/account/builder-profile-edits",
    express.json({ limit: "16kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const body = parseSubmissionBody(req.body);
        if (body === null) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );

        const claimFile = await readBuilderClaimStore(
          options.claimStore.stateRoot,
        );
        if (!findVerifiedBuilderAccountIds(claimFile).has(canonicalAccountId)) {
          sendFailure(res, 403, "PLATFORM_NOT_A_VERIFIED_BUILDER");
          return;
        }

        const verifiedClaims = findClaimsByAccount(
          claimFile,
          canonicalAccountId,
        ).filter((claim) => claim.state === "verified");
        const registryDir = options.identityRegistryDir ?? defaultIdentityRegistryDir;
        const snapshot = await loadIdentityRegistrySnapshot(registryDir);
        const ownedBuilderIds = new Set<string>();
        for (const claim of verifiedClaims) {
          const agent = snapshot.agents.find(
            (candidate) => candidate.id === claim.agentId,
          );
          if (agent !== undefined && agent.builderId !== null) {
            ownedBuilderIds.add(agent.builderId);
          }
        }

        const targetRecord = resolveOwnedTargetRecord(
          snapshot,
          ownedBuilderIds,
          body.targetKind,
          body.targetId,
        );
        if (targetRecord === null) {
          sendFailure(res, 403, "PLATFORM_NOT_YOUR_BUILDER_PROFILE");
          return;
        }
        if (!EDITABLE_FIELDS_BY_TARGET_KIND[body.targetKind].includes(body.field)) {
          sendFailure(res, 400, "PLATFORM_FIELD_NOT_EDITABLE");
          return;
        }

        // `body.field` was already confirmed above to be one of
        // `EDITABLE_FIELDS_BY_TARGET_KIND[body.targetKind]`'s real field
        // names for `targetRecord`'s union type; the compiler cannot
        // correlate that runtime allowlist check to a static key, so this
        // cast is the documented "field name resolved at runtime" case.
        const targetRecordFields = targetRecord as unknown as Record<string, unknown>;
        const previousValue = targetRecordFields[body.field];
        let updatedFile;
        try {
          updatedFile = await mutateBuilderEditStore(
            options.editStore.stateRoot,
            (file) =>
              submitEdit(
                file,
                {
                  accountId: canonicalAccountId,
                  targetKind: body.targetKind,
                  targetId: body.targetId,
                  field: body.field,
                  previousValue,
                  proposedValue: body.proposedValue,
                },
                new Date(),
              ),
          );
        } catch (error) {
          if (error instanceof BuilderEditValidationError) {
            sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
            return;
          }
          throw error;
        }
        // `submitEdit` always appends the new record at the tail of
        // `edits`, and this whole read-mutate-write cycle ran under the
        // store's own `FileMutex` — so the last element is exactly the
        // record just created, with no race against a concurrent writer.
        const edit = updatedFile.edits[updatedFile.edits.length - 1];
        res.status(200).json({ schemaVersion: 1, edit });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_builder_edit_submit_failed",
          error,
        );
      }
    },
  );

  return router;
}
