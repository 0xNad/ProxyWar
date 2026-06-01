import fs from "fs/promises";
import path from "path";
import { AgentManifest, validateAgentManifest } from "./AgentManifest";

export interface ExternalAgentDryRunManifestOptions {
  endpointUrl: string;
  timeoutMs?: number;
}

export interface ExternalAgentDryRunManifestWriteOptions
  extends ExternalAgentDryRunManifestOptions {
  directory: string;
}

export interface ExternalAgentDryRunSmokeOptions {
  manifestDir: string;
  maxSteps: number;
  turnsPerDecisionStep: number;
  replayTailTurns: number;
}

export interface ParsedExternalAgentDryRunSmokeOutput {
  runID: string | null;
  visualReportPath: string | null;
  openFrontReplayUrl: string | null;
}

const dryRunAgents: Array<{
  agentName: string;
  profile: AgentManifest["profile"];
  personality: string;
  skillPreferences: NonNullable<AgentManifest["skillPreferences"]>;
}> = [
  {
    agentName: "Endpoint Expander",
    profile: "aggressive",
    personality: "Expand early, pressure weak borders, and avoid idle turns.",
    skillPreferences: {
      expansion: 1,
      pressure: 0.85,
      attack_timing: 0.7,
    },
  },
  {
    agentName: "Endpoint Builder",
    profile: "defensive",
    personality: "Grow safely, build useful economy, and defend real borders.",
    skillPreferences: {
      economy_building: 1,
      defense_building: 0.85,
      troop_conservation: 0.8,
    },
  },
  {
    agentName: "Endpoint Diplomat",
    profile: "diplomatic",
    personality: "Prefer useful alliances, support stable allies, and expand safely.",
    skillPreferences: {
      diplomacy: 1,
      support_ally: 0.75,
      expansion: 0.65,
    },
  },
  {
    agentName: "Endpoint Opportunist",
    profile: "opportunistic",
    personality: "Take low-risk gains, exploit weak rivals, and avoid bad wars.",
    skillPreferences: {
      opportunism: 1,
      expansion: 0.85,
      attack_timing: 0.75,
    },
  },
];

export function buildExternalAgentDryRunManifests(
  options: ExternalAgentDryRunManifestOptions,
): AgentManifest[] {
  return dryRunAgents.map((agent) =>
    validateAgentManifest(
      {
        schemaVersion: 1,
        agentName: agent.agentName,
        profile: agent.profile,
        brainType: "external-http",
        plannerExecutorMode: false,
        personality: agent.personality,
        observationPolicy: "default",
        skillPreferences: agent.skillPreferences,
        provider: {
          provider: "external-http",
          endpointUrl: options.endpointUrl,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
      },
      agent.agentName,
    ),
  );
}

export async function writeExternalAgentDryRunManifests(
  options: ExternalAgentDryRunManifestWriteOptions,
): Promise<string[]> {
  await fs.mkdir(options.directory, { recursive: true });
  const manifests = buildExternalAgentDryRunManifests(options);
  const paths = await Promise.all(
    manifests.map(async (manifest, index) => {
      const filePath = path.join(
        options.directory,
        `${String(index + 1).padStart(2, "0")}-${safeFileName(
          manifest.agentName,
        )}.json`,
      );
      await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
      return filePath;
    }),
  );
  return paths;
}

export function buildExternalAgentDryRunSmokeArgs(
  options: ExternalAgentDryRunSmokeOptions,
): string[] {
  return [
    "src/scripts/ai-agent-league-smoke.ts",
    "--brain=planner",
    "--runner=step-locked",
    "--scenario=actions",
    "--map=Pangaea",
    "--map-size=Compact",
    "--vary-spawns",
    `--agent-manifest-dir=${options.manifestDir}`,
    `--max-steps=${options.maxSteps}`,
    `--turns-per-decision-step=${options.turnsPerDecisionStep}`,
    `--replay-tail-turns=${options.replayTailTurns}`,
  ];
}

export function parseExternalAgentDryRunSmokeOutput(
  output: string,
): ParsedExternalAgentDryRunSmokeOutput {
  return {
    runID:
      firstMatch(output, /runID:\s*'([^']+)'/) ??
      firstMatch(output, /"runID"\s*:\s*"([^"]+)"/),
    visualReportPath:
      firstMatch(output, /visualReportPath:\s*'([^']+)'/) ??
      firstMatch(output, /"visualReportPath"\s*:\s*"([^"]+)"/),
    openFrontReplayUrl:
      firstMatch(output, /openFrontReplayUrl:\s*'([^']+)'/) ??
      firstMatch(output, /"openFrontReplayUrl"\s*:\s*"([^"]+)"/),
  };
}

function firstMatch(value: string, pattern: RegExp): string | null {
  return value.match(pattern)?.[1] ?? null;
}

function safeFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
