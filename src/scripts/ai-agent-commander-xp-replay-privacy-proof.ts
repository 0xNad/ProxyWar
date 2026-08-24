import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commanderXpReplayEvidenceProjection } from "../server/agents/CommanderXpReplayEvidence";
// @ts-expect-error The reviewed external-seal helper is executable ESM without
// a declaration file. This proof intentionally exercises its production
// privacy scanner while disabling only Commander-specific Coworld joins that
// this historical, unseeded corpus cannot truthfully satisfy.
import { scanPrivacyAndInventory } from "../../.github/scripts/commander-xp-external-seal-lib.mjs";

export const COMMANDER_XP_PRIVACY_CORPUS_URL =
  "https://softmax-public.s3.amazonaws.com/replays/7659429d-579d-40b1-a031-6b09b9d1e637.replay";
export const COMMANDER_XP_PRIVACY_CORPUS_SHA256 =
  "d22465aa50b7fedb9ed1f4a664e7c39b81ea1c129fed3410dfbfb33a3d242a93";
export const COMMANDER_XP_PRIVACY_CORPUS_BYTES = 4_491_404;
const PROJECTION_PATH = "runs/provider-preflight/r00/A/replay-evidence.json";
const RECEIPT_FILE = "commander-xp-privacy-corpus-receipt-v1.json";
const SEAL_FILE = "commander-xp-privacy-corpus-seal-v1.json";

export async function proveCommanderXpReplayPrivacy(
  requestedOutputDirectory: string,
  fetchReplay: typeof fetch = fetch,
): Promise<{
  corpusSha256: string;
  corpusBytes: number;
  projectionSha256: string;
  receiptSha256: string;
  sealSha256: string;
  rawReplayRetained: false;
}> {
  const response = await fetchReplay(COMMANDER_XP_PRIVACY_CORPUS_URL);
  if (!response.ok) {
    throw new Error(`privacy corpus returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const corpusSha256 = sha256(bytes);
  if (
    bytes.byteLength !== COMMANDER_XP_PRIVACY_CORPUS_BYTES ||
    corpusSha256 !== COMMANDER_XP_PRIVACY_CORPUS_SHA256
  ) {
    throw new Error("privacy corpus identity mismatch");
  }
  const projection = commanderXpReplayEvidenceProjection(
    COMMANDER_XP_PRIVACY_CORPUS_URL,
    {
      xpRequestID: "xreq_privacy-corpus-only",
      episodeRequestID: "ereq_privacy-corpus-only",
      jobID: "7659429d-579d-40b1-a031-6b09b9d1e637",
      episodeID: "privacy-corpus-only",
      replayPath: "/replays/7659429d-579d-40b1-a031-6b09b9d1e637.replay",
      replayURLSha256: sha256(
        new TextEncoder().encode(COMMANDER_XP_PRIVACY_CORPUS_URL),
      ),
    },
    null,
    bytes,
  );
  if (
    projection.contentSha256 !== corpusSha256 ||
    projection.byteLength !== bytes.byteLength ||
    "inlineRunArtifacts" in projection ||
    "proxyWarArtifacts" in projection ||
    "spectatorReplay" in projection
  ) {
    throw new Error("privacy corpus projection is unsafe");
  }
  const outputDirectory = path.resolve(requestedOutputDirectory);
  const evidenceRoot = path.join(outputDirectory, "evidence");
  const projectionPath = path.join(evidenceRoot, PROJECTION_PATH);
  await fs.mkdir(path.dirname(projectionPath), { recursive: true });
  await fs.writeFile(
    projectionPath,
    `${JSON.stringify(projection, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  const receiptBody = {
    schemaVersion: 1,
    proofKind: "privacy-corpus-projection-only-not-commander-identity",
    corpusURL: COMMANDER_XP_PRIVACY_CORPUS_URL,
    corpusSha256,
    corpusBytes: bytes.byteLength,
    projectionPath: PROJECTION_PATH,
    projectionSha256: sha256(new Uint8Array(await fs.readFile(projectionPath))),
    rawReplayRetained: false as const,
  };
  const receipt = {
    ...receiptBody,
    receiptSha256: sha256ExternalCanonical(receiptBody),
  };
  await fs.writeFile(
    path.join(outputDirectory, RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  const inventory = await scanPrivacyAndInventory(evidenceRoot, {
    validateCoworldReceipts: false,
  });
  const sealBody = {
    schemaVersion: 1,
    proofKind: receipt.proofKind,
    receiptSha256: receipt.receiptSha256,
    privacyInventorySha256: sha256ExternalCanonical(inventory.files),
    fileCount: inventory.fileCount,
    totalBytes: inventory.totalBytes,
  };
  const seal = { ...sealBody, sealSha256: sha256ExternalCanonical(sealBody) };
  await fs.writeFile(
    path.join(outputDirectory, SEAL_FILE),
    `${JSON.stringify(seal, null, 2)}\n`,
    { flag: "wx" },
  );
  return await verifyCommanderXpReplayPrivacyProof(outputDirectory);
}

export async function verifyCommanderXpReplayPrivacyProof(
  requestedOutputDirectory: string,
): Promise<{
  corpusSha256: string;
  corpusBytes: number;
  projectionSha256: string;
  receiptSha256: string;
  sealSha256: string;
  rawReplayRetained: false;
}> {
  const outputDirectory = await fs.realpath(
    path.resolve(requestedOutputDirectory),
  );
  const evidenceRoot = path.join(outputDirectory, "evidence");
  const receipt = JSON.parse(
    await fs.readFile(path.join(outputDirectory, RECEIPT_FILE), "utf8"),
  ) as Record<string, unknown>;
  const seal = JSON.parse(
    await fs.readFile(path.join(outputDirectory, SEAL_FILE), "utf8"),
  ) as Record<string, unknown>;
  exactKeys(receipt, [
    "schemaVersion",
    "proofKind",
    "corpusURL",
    "corpusSha256",
    "corpusBytes",
    "projectionPath",
    "projectionSha256",
    "rawReplayRetained",
    "receiptSha256",
  ]);
  exactKeys(seal, [
    "schemaVersion",
    "proofKind",
    "receiptSha256",
    "privacyInventorySha256",
    "fileCount",
    "totalBytes",
    "sealSha256",
  ]);
  const { receiptSha256, ...receiptBody } = receipt;
  const { sealSha256, ...sealBody } = seal;
  const inventory = await scanPrivacyAndInventory(evidenceRoot, {
    validateCoworldReceipts: false,
  });
  const projectionBytes = new Uint8Array(
    await fs.readFile(path.join(evidenceRoot, PROJECTION_PATH)),
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.proofKind !==
      "privacy-corpus-projection-only-not-commander-identity" ||
    receipt.corpusURL !== COMMANDER_XP_PRIVACY_CORPUS_URL ||
    receipt.corpusSha256 !== COMMANDER_XP_PRIVACY_CORPUS_SHA256 ||
    receipt.corpusBytes !== COMMANDER_XP_PRIVACY_CORPUS_BYTES ||
    receipt.projectionPath !== PROJECTION_PATH ||
    receipt.projectionSha256 !== sha256(projectionBytes) ||
    receipt.rawReplayRetained !== false ||
    receiptSha256 !== sha256ExternalCanonical(receiptBody) ||
    seal.schemaVersion !== 1 ||
    seal.proofKind !== receipt.proofKind ||
    seal.receiptSha256 !== receiptSha256 ||
    seal.privacyInventorySha256 !== sha256ExternalCanonical(inventory.files) ||
    seal.fileCount !== inventory.fileCount ||
    seal.totalBytes !== inventory.totalBytes ||
    sealSha256 !== sha256ExternalCanonical(sealBody) ||
    inventory.files.length !== 1 ||
    inventory.files[0]?.path !== PROJECTION_PATH
  ) {
    throw new Error("privacy corpus receipt or seal verification failed");
  }
  return {
    corpusSha256: receipt.corpusSha256,
    corpusBytes: receipt.corpusBytes,
    projectionSha256: receipt.projectionSha256,
    receiptSha256,
    sealSha256,
    rawReplayRetained: false,
  } as ReturnType<typeof verifyCommanderXpReplayPrivacyProof> extends Promise<
    infer Result
  >
    ? Result
    : never;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new Error("privacy corpus proof schema mismatch");
  }
}

function sha256ExternalCanonical(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((entry as Record<string, unknown>)[key])]),
      );
    }
    return entry;
  };
  return sha256(new TextEncoder().encode(`${JSON.stringify(sort(value))}\n`));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runCommanderXpReplayPrivacyProofCli(
  args: readonly string[],
): Promise<number> {
  if (args.length !== 1 || args[0]?.trim() === "") {
    console.error(
      "usage: ai-agent-commander-xp-replay-privacy-proof <new-output-directory>",
    );
    return 2;
  }
  console.log(JSON.stringify(await proveCommanderXpReplayPrivacy(args[0]!)));
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runCommanderXpReplayPrivacyProofCli(process.argv.slice(2))
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "privacy proof failed",
      );
      process.exitCode = 1;
    });
}
