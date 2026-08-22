import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommanderXpPreRegistration,
  type CommanderXpPlanInput,
} from "../server/agents/CommanderXpProtocol";

export async function runCommanderXpPlanCli(
  args: readonly string[],
): Promise<number> {
  if (args.length !== 2) {
    console.error(
      "usage: ai-agent-commander-xp-plan <input.json> <new-output-directory>",
    );
    return 2;
  }
  const inputPath = path.resolve(args[0]!);
  const outputDirectory = path.resolve(args[1]!);
  const input = JSON.parse(
    await fs.readFile(inputPath, "utf8"),
  ) as CommanderXpPlanInput;
  const plan = buildCommanderXpPreRegistration(input);
  await fs.mkdir(outputDirectory, { recursive: false });
  const planPath = path.join(
    outputDirectory,
    "commander-xp-preregistration-v2.json",
  );
  const requestsPath = path.join(
    outputDirectory,
    "commander-xp-request-plan-v2.jsonl",
  );
  const hashPath = path.join(
    outputDirectory,
    "commander-xp-preregistration-v2.sha256",
  );
  await Promise.all([
    fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
      flag: "wx",
    }),
    fs.writeFile(
      requestsPath,
      `${[...plan.providerPreflightRequests, ...plan.requests]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      { flag: "wx" },
    ),
    fs.writeFile(
      hashPath,
      `${plan.preRegistrationSha256}  commander-xp-preregistration-v2.json\n`,
      { flag: "wx" },
    ),
  ]);
  console.log(
    JSON.stringify({
      ok: true,
      mode: "plan-only-no-requests-created",
      preRegistrationSha256: plan.preRegistrationSha256,
      providerPreflightRequestCount: plan.providerPreflightRequests.length,
      gameplayRequestCount: plan.requests.length,
      requestCount:
        plan.requests.length + plan.providerPreflightRequests.length,
      outputDirectory,
    }),
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCommanderXpPlanCli(process.argv.slice(2));
}
