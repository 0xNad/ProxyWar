import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commanderXpReplayEvidenceProjection } from "../../coworld-adapter/src/commander-xp-collect";

export const COMMANDER_XP_PRIVACY_CORPUS_URL =
  "https://softmax-public.s3.amazonaws.com/replays/7659429d-579d-40b1-a031-6b09b9d1e637.replay";
export const COMMANDER_XP_PRIVACY_CORPUS_SHA256 =
  "d22465aa50b7fedb9ed1f4a664e7c39b81ea1c129fed3410dfbfb33a3d242a93";
export const COMMANDER_XP_PRIVACY_CORPUS_BYTES = 4_491_404;

export async function proveCommanderXpReplayPrivacy(
  requestedOutputDirectory: string,
  fetchReplay: typeof fetch = fetch,
): Promise<{
  corpusSha256: string;
  corpusBytes: number;
  projectionSha256: string;
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
  await fs.mkdir(outputDirectory, { recursive: false });
  const projectionPath = path.join(outputDirectory, "replay-evidence.json");
  await fs.writeFile(
    projectionPath,
    `${JSON.stringify(projection, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  const proof = {
    schemaVersion: 1,
    proofKind: "privacy-corpus-projection-only-not-commander-identity",
    corpusURL: COMMANDER_XP_PRIVACY_CORPUS_URL,
    corpusSha256,
    corpusBytes: bytes.byteLength,
    projectionPath: "replay-evidence.json",
    projectionSha256: sha256(new Uint8Array(await fs.readFile(projectionPath))),
    rawReplayRetained: false as const,
  };
  await fs.writeFile(
    path.join(outputDirectory, "privacy-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
    { flag: "wx" },
  );
  return {
    corpusSha256,
    corpusBytes: bytes.byteLength,
    projectionSha256: proof.projectionSha256,
    rawReplayRetained: false,
  };
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
