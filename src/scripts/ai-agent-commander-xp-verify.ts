import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyCommanderXpEvidence } from "../server/agents/CommanderXpVerifier";

export async function runCommanderXpVerifierCli(
  args: readonly string[],
): Promise<number> {
  if (args.length !== 1 || args[0]?.trim() === "") {
    console.error(
      JSON.stringify({
        schemaVersion: 2,
        integrityVerified: false,
        experimentUsable: false,
        diagnostics: [{ code: "USAGE_INVALID", path: null }],
        performanceClaimAuthorized: false,
      }),
    );
    return 2;
  }
  const verification = await verifyCommanderXpEvidence(args[0]!);
  console.log(JSON.stringify(verification));
  return verification.experimentUsable ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCommanderXpVerifierCli(process.argv.slice(2));
}
