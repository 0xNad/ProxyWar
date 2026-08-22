import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CommanderXpPreRegistrationV2 } from "../server/agents/CommanderXpProtocol";
import { verifyCommanderXpEvidence } from "../server/agents/CommanderXpVerifier";

type CommanderXpEvidencePhase =
  | "preregistration"
  | "provider-preflight"
  | "canary"
  | "confirmatory";

export interface CommanderXpAuthorityRequestInput {
  schemaVersion: 1;
  phase: CommanderXpEvidencePhase;
  sourceCI: Record<string, unknown>;
  sourceArtifact: Record<string, unknown>;
  sourceAllowlist: string[];
  preregistrationReceipt: Record<string, unknown> | null;
  providerPreflightReceipt: Record<string, unknown> | null;
  priorPhaseReceipt: Record<string, unknown> | null;
  canaryReceipt: Record<string, unknown> | null;
}

export async function buildCommanderXpAuthorityRequest(
  input: CommanderXpAuthorityRequestInput,
  requestedEvidenceRoot: string,
  requestedOutputDirectory: string,
): Promise<{
  requestPath: string;
  requestSha256: string;
}> {
  if (input.schemaVersion !== 1) {
    throw new Error("Commander XP authority input schema is invalid");
  }
  const evidenceRoot = await canonicalDirectory(requestedEvidenceRoot);
  if (path.basename(evidenceRoot) !== "evidence") {
    throw new Error("Commander XP evidence root must be named evidence");
  }
  const requestedOutput = path.resolve(requestedOutputDirectory);
  const outputParent = await fs.realpath(path.dirname(requestedOutput));
  const outputDirectory = path.join(
    outputParent,
    path.basename(requestedOutput),
  );
  if (
    path.basename(outputDirectory) !== "authority" ||
    outputParent !== path.dirname(evidenceRoot)
  ) {
    throw new Error(
      "Commander XP authority artifact must be staged beside evidence",
    );
  }
  const localVerification = await verifyCommanderXpEvidence(evidenceRoot);
  if (
    !localVerification.integrityVerified ||
    localVerification.phase !== input.phase
  ) {
    throw new Error(
      "Commander XP evidence failed local integrity verification",
    );
  }
  const preregistrationPath = path.join(
    evidenceRoot,
    "commander-xp-preregistration-v2.json",
  );
  const indexPath = path.join(
    evidenceRoot,
    "commander-xp-evidence-index-v2.json",
  );
  const sealPath = path.join(
    evidenceRoot,
    "commander-xp-evidence-seal-v2.json",
  );
  const preregistration = JSON.parse(
    await fs.readFile(preregistrationPath, "utf8"),
  ) as CommanderXpPreRegistrationV2;
  const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
    experimentID: string;
    phase: CommanderXpEvidencePhase;
  };
  const seal = JSON.parse(await fs.readFile(sealPath, "utf8")) as {
    experimentID: string;
    phase: CommanderXpEvidencePhase;
    sealSha256: string;
  };
  if (
    preregistration.experimentID !== index.experimentID ||
    preregistration.experimentID !== seal.experimentID ||
    index.phase !== input.phase ||
    seal.phase !== input.phase
  ) {
    throw new Error("Commander XP evidence identity is inconsistent");
  }
  if (
    input.sourceAllowlist.length === 0 ||
    new Set(input.sourceAllowlist).size !== input.sourceAllowlist.length ||
    input.sourceAllowlist.some(
      (entry, index) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry !== [...input.sourceAllowlist].sort()[index],
    )
  ) {
    throw new Error("Commander XP source allowlist is invalid");
  }
  const request = {
    schemaVersion: 1,
    experimentID: preregistration.experimentID,
    phase: input.phase,
    sourceCI: input.sourceCI,
    sourceArtifact: input.sourceArtifact,
    source: {
      behaviorBaseSha: preregistration.identities.behaviorSourceSha,
      behaviorBaseTreeSha: preregistration.identities.behaviorSourceTreeSha,
      workflowSourceSha: preregistration.identities.adapterSourceSha,
      workflowSourceTreeSha: preregistration.identities.adapterSourceTreeSha,
      sourceAllowlist: input.sourceAllowlist,
    },
    evidence: {
      preRegistrationPath: "commander-xp-preregistration-v2.json",
      preRegistrationSha256: await sha256File(preregistrationPath),
      localIndexPath: "commander-xp-evidence-index-v2.json",
      localIndexSha256: await sha256File(indexPath),
      localSealPath: "commander-xp-evidence-seal-v2.json",
      localSealFileSha256: await sha256File(sealPath),
      localSealSha256: seal.sealSha256,
    },
    preregistrationReceipt: input.preregistrationReceipt,
    providerPreflightReceipt: input.providerPreflightReceipt,
    priorPhaseReceipt: input.priorPhaseReceipt,
    canaryReceipt: input.canaryReceipt,
  };
  await fs.mkdir(outputDirectory, { recursive: false });
  const requestPath = path.join(
    outputDirectory,
    "commander-xp-external-seal-request-v1.json",
  );
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    flag: "wx",
  });
  const authorityVerification = await verifyCommanderXpEvidence(
    evidenceRoot,
    requestPath,
  );
  if (!authorityVerification.integrityVerified) {
    throw new Error(
      `Commander XP authority request failed verification: ${authorityVerification.diagnostics[0]?.code ?? "unknown"}`,
    );
  }
  return { requestPath, requestSha256: await sha256File(requestPath) };
}

async function canonicalDirectory(requested: string): Promise<string> {
  const resolved = path.resolve(requested);
  const real = await fs.realpath(resolved);
  if (!(await fs.stat(real)).isDirectory()) {
    throw new Error("Commander XP evidence root is invalid");
  }
  return real;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

export async function runCommanderXpAuthorityRequestCli(
  args: readonly string[],
): Promise<number> {
  if (args.length !== 3) {
    console.error(
      "usage: ai-agent-commander-xp-authority-request <input.json> <evidence-root> <new-authority-directory>",
    );
    return 2;
  }
  const input = JSON.parse(
    await fs.readFile(path.resolve(args[0]!), "utf8"),
  ) as CommanderXpAuthorityRequestInput;
  console.log(
    JSON.stringify(
      await buildCommanderXpAuthorityRequest(input, args[1]!, args[2]!),
    ),
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runCommanderXpAuthorityRequestCli(process.argv.slice(2))
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "authority request failed",
      );
      process.exitCode = 1;
    });
}
