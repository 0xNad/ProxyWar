import { spawn } from "child_process";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";

const sessionID = "relay_1234567890abcdef12345678";
const relayToken = "relay-sim-token";

async function run(): Promise<void> {
  const server = await startFakeRelayServer();
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake relay server did not bind to a TCP port");
  }
  const relayBaseUrl = `http://127.0.0.1:${address.port}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-relay-sim-"));
  try {
    await writeRelayRoster(tempDir, relayBaseUrl);
    const runID = `relay-sim-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await runSmoke(tempDir, runID);
    console.log("PASS managed relay fake-worker match");
    console.log(`runID=${runID}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function startFakeRelayServer(): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== `/api/agent-relay/sessions/${sessionID}/requests`
      ) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${relayToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      const body = JSON.parse(await readBody(request)) as {
        request?: {
          legalActions?: Array<{ id?: string; kind?: string }>;
        };
      };
      const legalActions = Array.isArray(body.request?.legalActions)
        ? body.request.legalActions
        : [];
      const selected =
        legalActions.find((action) => action.kind !== "hold")?.id ??
        legalActions[0]?.id;
      if (typeof selected !== "string" || selected.trim() === "") {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no legal actions" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          requestID: "req_fake",
          responseText: JSON.stringify({
            selectedLegalActionId: selected,
            reason: "Fake relay worker selected the first useful offered id.",
            confidence: 0.6,
          }),
        }),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "fake relay failed",
        }),
      );
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function writeRelayRoster(dir: string, relayBaseUrl: string): Promise<void> {
  const manifests = [
    {
      schemaVersion: 1,
      agentName: "Relay Sim",
      profile: "opportunistic",
      brainType: "external-relay",
      plannerExecutorMode: false,
      personality: "No-secret relay simulation agent.",
      observationPolicy: "default",
      provider: {
        provider: "external-relay",
        relayBaseUrl,
        sessionID,
        token: relayToken,
        timeoutMs: 30_000,
      },
    },
    manifest("Aggressive Sim", "aggressive"),
    manifest("Defensive Sim", "defensive"),
    manifest("Diplomatic Sim", "diplomatic"),
  ];
  await Promise.all(
    manifests.map((entry, index) =>
      fs.writeFile(
        path.join(dir, `${String(index + 1).padStart(2, "0")}.json`),
        `${JSON.stringify(entry, null, 2)}\n`,
      ),
    ),
  );
}

function manifest(agentName: string, profile: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agentName,
    profile,
    brainType: "planner",
    plannerExecutorMode: true,
    personality: "Local deterministic support agent for relay simulation.",
    observationPolicy: "default",
    provider: { provider: "mock-llm" },
  };
}

function runSmoke(manifestDir: string, runID: string): Promise<void> {
  const executable = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const args = [
    "src/scripts/ai-agent-league-smoke.ts",
    "--brain=planner",
    "--runner=step-locked",
    "--scenario=actions",
    "--max-steps=2",
    "--turns-per-decision-step=25",
    "--replay-tail-turns=25",
    "--bots=0",
    "--nations=disabled",
    "--map=Pangaea",
    "--map-size=Compact",
    "--vary-spawns",
    `--agent-manifest-dir=${manifestDir}`,
    `--run-id=${runID}`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GAME_ENV: "dev",
        AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`relay sim smoke exited ${code}\n${output}`));
    });
  });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
