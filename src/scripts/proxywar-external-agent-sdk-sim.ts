import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import {
  parseProxyWarAgentCardMarkdown,
} from "../server/agents/ProxyWarAgentCard";
import {
  checkExternalAgentEndpoint,
  normalizeExternalAgentHealthCheckInput,
} from "../server/agents/ExternalAgentHealthCheck";
import {
  createProxyWarNationManifest,
} from "../server/agents/ProxyWarNationRegistry";

const root = process.cwd();
const exampleDir = path.join(root, "examples", "external-agent");
const port = await freePort();
const commandScript = path.join(
  os.tmpdir(),
  `proxywar-sdk-sim-command-${process.pid}.mjs`,
);
const endpointUrl = `http://127.0.0.1:${port}/proxywar/decide`;
const previousAllowPrivate = process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS;
process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS = "true";

let child: ChildProcess | null = null;
try {
  await fs.writeFile(
    commandScript,
    [
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (!prompt.includes('selectableActionIDs')) process.exit(2);",
      "  const listMatch = /\\\"selectableActionIDs\\\"\\s*:\\s*\\[([\\s\\S]*?)\\]/.exec(prompt);",
      "  const ids = listMatch ? Array.from(listMatch[1].matchAll(/\\\"((?:\\\\\\\\.|[^\\\"])*)\\\"/g), (match) => JSON.parse(`\\\"${match[1]}\\\"`)) : [];",
      "  const selected = ids.find((id) => !String(id).includes('hold')) ?? ids[0];",
      "  if (!selected) process.exit(3);",
      "  console.log(JSON.stringify({",
      "    selectedLegalActionId: selected,",
      "    reason: `SDK sim command selected offered id ${selected}.`,",
      "    confidence: 0.91",
      "  }));",
      "});",
      "",
    ].join("\n"),
  );

  child = spawn(process.execPath, ["simple-agent.mjs"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PROXYWAR_AGENT_HOST: "127.0.0.1",
      PROXYWAR_AGENT_PORT: String(port),
      PROXYWAR_AGENT_PUBLIC_URL: "https://agent.example.test",
      PROXYWAR_AGENT_NAME: "SDK Sim Frontier",
      PROXYWAR_AGENT_LLM_PROVIDER: "command",
      PROXYWAR_AGENT_LLM_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(commandScript)}`,
      PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS: "120000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let childOutput = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    childOutput += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    childOutput += chunk;
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      childOutput += `\nstarter exited with ${code}\n`;
    }
  });

  await waitForHealth(`http://127.0.0.1:${port}/health`, () => childOutput);
  console.log("PASS starter /health became ready");

  const health = await checkExternalAgentEndpoint(
    normalizeExternalAgentHealthCheckInput({
      endpointUrl,
      timeoutMs: 120_000,
    }),
  );
  if (!health.ok) {
    throw new Error(`health check failed: ${health.failureReason} ${health.fixHint ?? ""}`);
  }
  console.log(`PASS platform health check selected ${health.selectedLegalActionId}`);

  const smoke = await runNode(["smoke-test.mjs"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PROXYWAR_AGENT_TEST_ENDPOINT_URL: endpointUrl,
      PROXYWAR_AGENT_TEST_TIMEOUT_MS: "120000",
    },
  });
  if (smoke.code !== 0) {
    throw new Error(`starter self-test failed:\n${smoke.output}`);
  }
  console.log("PASS starter npm self-test path");

  const cardText = await fetchText(`http://127.0.0.1:${port}/agent-card.md`);
  const card = parseProxyWarAgentCardMarkdown(
    cardText,
    "https://agent.example.test/agent-card.md",
  );
  if (card.nationInput.endpointUrl !== "https://agent.example.test/proxywar/decide") {
    throw new Error(`unexpected Agent Card endpoint ${card.nationInput.endpointUrl}`);
  }
  console.log("PASS generated Agent Card imports as public HTTPS endpoint");

  const manifest = createProxyWarNationManifest(card.nationInput);
  if (manifest.provider?.provider !== "external-http") {
    throw new Error("generated Agent Card did not create external-http manifest");
  }
  console.log("PASS Agent Card converts to saved external-agent manifest");

  const sdk = (await import(
    pathToFileURL(path.join(exampleDir, "starter-framework.mjs")).href
  )) as {
    validateDecisionOutput: (
      raw: string,
      legalActions: Array<{ id: string; kind: string }>,
    ) => { ok: boolean; error?: string };
  };
  const invalid = sdk.validateDecisionOutput(
    '```json\n{"selectedLegalActionId":"health-check:expand","reason":"fenced"}\n```',
    [{ id: "health-check:expand", kind: "attack" }],
  );
  if (invalid.ok || !invalid.error?.includes("markdown code fence")) {
    throw new Error("starter SDK did not reject markdown-wrapped decisions");
  }
  console.log("PASS starter SDK rejects markdown-wrapped decisions");

  const dryRun = await runCommand(localBin("tsx"), [
    "src/scripts/proxywar-external-agent-dry-run.ts",
    `--endpoint-url=${endpointUrl}`,
    "--timeout-ms=120000",
    "--max-steps=1",
    "--turns-per-decision-step=25",
    "--replay-tail-turns=50",
  ], {
    cwd: root,
    env: {
      ...process.env,
      GAME_ENV: "dev",
      PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
    },
  });
  if (dryRun.code !== 0) {
    throw new Error(`external-agent dry run failed:\n${dryRun.output}`);
  }
  if (
    !dryRun.output.includes("ProxyWar external-agent dry run passed") ||
    !dryRun.output.includes("openFrontReplayUrl") ||
    !dryRun.output.includes("external-agent-feedback.md")
  ) {
    throw new Error(
      `external-agent dry run did not report replay and feedback artifacts:\n${dryRun.output}`,
    );
  }
  console.log("PASS no-secret match produced replay and external-agent feedback");

  console.log("ProxyWar external-agent SDK sim passed.");
} finally {
  child?.kill("SIGTERM");
  await fs.rm(commandScript, { force: true });
  if (previousAllowPrivate === undefined) {
    delete process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS;
  } else {
    process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS = previousAllowPrivate;
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("could not allocate a local port");
  }
  return address.port;
}

async function waitForHealth(url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the starter finishes binding or exits.
    }
    await delay(250);
  }
  throw new Error(`starter did not become healthy at ${url}\n${output()}`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function localBin(name: string): string {
  return path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function runNode(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; output: string }> {
  return runCommand(process.execPath, args, options);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
