import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  AgentManifest,
  loadAgentManifestsFromDirectory,
  validateAgentManifest,
} from "./AgentManifest";
import {
  AgentStrategyProfile,
  agentStrategyProfiles,
} from "./AgentTypes";
import { normalizeExternalAgentEndpointUrl } from "./ExternalAgentNetworkPolicy";
import {
  normalizeExternalAgentTokenInput,
  storeExternalAgentTokenSecret,
} from "./ExternalAgentSecrets";
import { StrategicSkill, strategicSkills } from "./AgentStrategicSkills";

export type ProxyWarDoctrine =
  | "balanced"
  | "economic"
  | "fortress"
  | "diplomatic"
  | "pressure";

export interface CreateProxyWarNationInput {
  agentName?: unknown;
  profile?: unknown;
  doctrine?: unknown;
  personality?: unknown;
  policyChangelog?: unknown;
  agentMode?: unknown;
  endpointUrl?: unknown;
  endpointToken?: unknown;
  endpointTokenEnv?: unknown;
  endpointTimeoutMs?: unknown;
  relayBaseUrl?: unknown;
  relaySessionID?: unknown;
  relayToken?: unknown;
  relayTokenEnv?: unknown;
  relayTimeoutMs?: unknown;
}

export interface ProxyWarNationEntry extends AgentManifest {
  nationID: string;
  fileName: string;
  filePath: string;
  createdAt: string;
}

export interface SaveProxyWarNationOptions {
  nationsDir?: string;
  curatedManifestDir?: string;
  activeRosterDir?: string;
  secretStorePath?: string;
  allowTokenReferences?: boolean;
  pinnedNationID?: string;
  maxSavedNations?: number;
}

export const defaultProxyWarNationsDir = path.join(
  process.cwd(),
  "artifacts",
  "proxywar",
  "nations",
);
export const defaultProxyWarActiveRosterDir = path.join(
  process.cwd(),
  "artifacts",
  "proxywar",
  "active-roster",
);
export const defaultCuratedManifestDir = path.join(
  process.cwd(),
  "docs",
  "ai-league-agent-manifests",
);

const doctrines: readonly ProxyWarDoctrine[] = [
  "balanced",
  "economic",
  "fortress",
  "diplomatic",
  "pressure",
];

export async function saveProxyWarNation(
  input: CreateProxyWarNationInput,
  options: SaveProxyWarNationOptions = {},
): Promise<{
  nation: ProxyWarNationEntry;
  activeRosterDir: string;
  activeRoster: AgentManifest[];
}> {
  const nationsDir = options.nationsDir ?? defaultProxyWarNationsDir;
  const activeRosterDir =
    options.activeRosterDir ?? defaultProxyWarActiveRosterDir;
  await fs.mkdir(nationsDir, { recursive: true });
  if (options.allowTokenReferences !== true) {
    rejectUserSuppliedTokenReferences(input);
  }
  const createdAt = new Date().toISOString();
  const nationID = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const manifest = createProxyWarNationManifest(
    await protectExternalAgentToken(input, {
      secretStorePath: options.secretStorePath,
      label: nationID,
    }),
  );
  const fileName = `${safePathSegment(nationID)}-${safePathSegment(
    manifest.agentName,
  )}.json`;
  const filePath = path.join(nationsDir, fileName);
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ ...manifest, proxyWar: { nationID, createdAt } }, null, 2)}\n`,
  );
  const activeRoster = await syncProxyWarActiveRoster({
    nationsDir,
    activeRosterDir,
    curatedManifestDir: options.curatedManifestDir,
  });
  return {
    nation: {
      ...manifest,
      nationID,
      fileName,
      filePath,
      createdAt,
    },
    activeRosterDir,
    activeRoster,
  };
}

function rejectUserSuppliedTokenReferences(
  input: CreateProxyWarNationInput,
): void {
  if (input.agentMode !== "external-http" && input.agentMode !== "external-relay") {
    return;
  }
  const tokenEnv =
    input.agentMode === "external-relay"
      ? input.relayTokenEnv
      : input.endpointTokenEnv;
  const token =
    input.agentMode === "external-relay" ? input.relayToken : input.endpointToken;
  if (tokenEnv !== undefined) {
    throw new Error(
      "External agent env token references are operator-only. Paste a beta-only token or leave the token blank.",
    );
  }
  if (typeof token !== "string") {
    return;
  }
  const cleanedToken = token.trim().toLowerCase();
  if (cleanedToken.startsWith("env:") || cleanedToken.startsWith("secret:")) {
    throw new Error(
      "External agent token references are operator-only. Paste a beta-only token or leave the token blank.",
    );
  }
}

export function createProxyWarNationManifest(
  input: CreateProxyWarNationInput,
): AgentManifest {
  const agentName = cleanText(input.agentName, {
    label: "Nation name",
    min: 2,
    max: 60,
  });
  const profile = enumValue(
    input.profile,
    agentStrategyProfiles,
    "profile",
  ) as AgentStrategyProfile;
  const doctrine = enumValue(input.doctrine, doctrines, "doctrine");
  const personality = cleanText(input.personality ?? defaultPersonality(profile), {
    label: "Doctrine note",
    min: 0,
    max: 240,
  });
  const policyChangelog = cleanText(input.policyChangelog, {
    label: "Policy changelog",
    min: 0,
    max: 600,
  });
  const agentMode =
    input.agentMode === "external-http" || input.agentMode === "external-relay"
      ? input.agentMode
      : "manifest";
  const externalProvider =
    agentMode === "external-http"
      ? externalHttpProvider(input)
      : agentMode === "external-relay"
        ? externalRelayProvider(input)
        : null;
  return validateAgentManifest(
    {
      schemaVersion: 1,
      agentName,
      profile,
      brainType:
        agentMode === "external-http" || agentMode === "external-relay"
          ? agentMode
          : "planner",
      plannerExecutorMode:
        agentMode !== "external-http" && agentMode !== "external-relay",
      personality: personality || defaultPersonality(profile),
      ...(policyChangelog !== "" ? { policyChangelog } : {}),
      observationPolicy: "default",
      skillPreferences: skillPreferencesForDoctrine(profile, doctrine),
      provider: externalProvider ?? { provider: "mock-llm" },
    },
    "Proxy War nation",
  );
}

export async function listProxyWarNations(
  nationsDir = defaultProxyWarNationsDir,
): Promise<ProxyWarNationEntry[]> {
  try {
    await fs.mkdir(nationsDir, { recursive: true });
    const files = (await fs.readdir(nationsDir))
      .filter((file) => file.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a));
    const entries = await Promise.all(
      files.map(async (fileName) => {
        const filePath = path.join(nationsDir, fileName);
        const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
          string,
          unknown
        >;
        const manifest = validateAgentManifest(raw, fileName);
        const meta =
          raw.proxyWar !== null &&
          typeof raw.proxyWar === "object" &&
          !Array.isArray(raw.proxyWar)
            ? (raw.proxyWar as Record<string, unknown>)
            : {};
        return {
          ...manifest,
          nationID:
            typeof meta.nationID === "string"
              ? meta.nationID
              : fileName.replace(/\.json$/, ""),
          createdAt:
            typeof meta.createdAt === "string"
              ? meta.createdAt
              : "unknown",
          fileName,
          filePath,
        };
      }),
    );
    return entries;
  } catch {
    return [];
  }
}

export async function deleteProxyWarNation(
  nationID: string,
  options: SaveProxyWarNationOptions = {},
): Promise<{
  deletedNation: ProxyWarNationEntry;
  activeRoster: AgentManifest[];
}> {
  const nationsDir = options.nationsDir ?? defaultProxyWarNationsDir;
  const activeRosterDir =
    options.activeRosterDir ?? defaultProxyWarActiveRosterDir;
  const nations = await listProxyWarNations(nationsDir);
  const deletedNation = nations.find((nation) => nation.nationID === nationID);
  if (deletedNation === undefined) {
    throw new Error("Saved nation was not found");
  }
  const resolvedNationsDir = path.resolve(nationsDir);
  const resolvedFilePath = path.resolve(deletedNation.filePath);
  if (
    resolvedFilePath !== resolvedNationsDir &&
    !resolvedFilePath.startsWith(`${resolvedNationsDir}${path.sep}`)
  ) {
    throw new Error("Saved nation path is outside the nations directory");
  }
  await fs.rm(resolvedFilePath, { force: true });
  const activeRoster = await syncProxyWarActiveRoster({
    nationsDir,
    activeRosterDir,
    curatedManifestDir: options.curatedManifestDir,
  });
  return { deletedNation, activeRoster };
}

export async function syncProxyWarActiveRoster(input: {
  nationsDir?: string;
  curatedManifestDir?: string;
  activeRosterDir?: string;
  pinnedNationID?: string;
  maxSavedNations?: number;
  includeCuratedDefaults?: boolean;
  minRosterSize?: number;
} = {}): Promise<AgentManifest[]> {
  const nationsDir = input.nationsDir ?? defaultProxyWarNationsDir;
  const curatedManifestDir =
    input.curatedManifestDir ?? defaultCuratedManifestDir;
  const activeRosterDir =
    input.activeRosterDir ?? defaultProxyWarActiveRosterDir;
  const savedNations = await listProxyWarNations(nationsDir);
  const curated = await loadAgentManifestsFromDirectory(curatedManifestDir);
  const maxSavedNations =
    input.maxSavedNations === undefined
      ? 8
      : Math.max(0, Math.min(8, Math.floor(input.maxSavedNations)));
  const pinned =
    input.pinnedNationID === undefined
      ? []
      : savedNations.filter((nation) => nation.nationID === input.pinnedNationID);
  const rest = savedNations.filter(
    (nation) => nation.nationID !== input.pinnedNationID,
  );
  const chosenSaved = [...pinned, ...rest].slice(0, maxSavedNations);
  const combined: AgentManifest[] = [...chosenSaved];
  if (input.includeCuratedDefaults !== false) {
    for (const manifest of curated) {
      if (combined.length >= 4 && chosenSaved.length > 0) break;
      if (combined.length >= 8) break;
      combined.push(manifest);
    }
  }
  const minRosterSize =
    input.minRosterSize === undefined
      ? input.includeCuratedDefaults === false
        ? 1
        : 4
      : Math.max(1, Math.min(8, Math.floor(input.minRosterSize)));
  const activeRoster = combined.slice(
    0,
    Math.max(minRosterSize, Math.min(8, combined.length)),
  );
  if (activeRoster.length < minRosterSize) {
    throw new Error(
      input.includeCuratedDefaults === false
        ? "Connect and save at least one external agent before running the beta match"
        : "Proxy War active roster needs at least 4 agents",
    );
  }
  await fs.rm(activeRosterDir, { recursive: true, force: true });
  await fs.mkdir(activeRosterDir, { recursive: true });
  await Promise.all(
    activeRoster.map((manifest, index) =>
      fs.writeFile(
        path.join(
          activeRosterDir,
          `${String(index + 1).padStart(2, "0")}-${safePathSegment(
            manifest.agentName,
          )}.json`,
        ),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    ),
  );
  return activeRoster;
}

function skillPreferencesForDoctrine(
  profile: AgentStrategyProfile,
  doctrine: ProxyWarDoctrine,
): Partial<Record<StrategicSkill, number>> {
  const base: Partial<Record<StrategicSkill, number>> = {
    opportunism: 0.55,
    troop_conservation: 0.55,
  };
  const profileSkills: Record<
    AgentStrategyProfile,
    Partial<Record<StrategicSkill, number>>
  > = {
    aggressive: { expansion: 0.9, pressure: 0.9, attack_timing: 0.8 },
    defensive: { defense_building: 0.95, troop_conservation: 0.9, recovery: 0.75 },
    diplomatic: { diplomacy: 0.95, support_ally: 0.85, economy_building: 0.6 },
    opportunistic: { opportunism: 1, expansion: 0.75, attack_timing: 0.65 },
  };
  const doctrineSkills: Record<
    ProxyWarDoctrine,
    Partial<Record<StrategicSkill, number>>
  > = {
    balanced: { expansion: 0.7, economy_building: 0.7, diplomacy: 0.55 },
    economic: { economy_building: 1, expansion: 0.75, troop_conservation: 0.75 },
    fortress: { defense_building: 1, recovery: 0.85, troop_conservation: 0.9 },
    diplomatic: { diplomacy: 1, support_ally: 0.9, troop_conservation: 0.65 },
    pressure: { pressure: 1, attack_timing: 0.85, expansion: 0.65 },
  };
  return normalizeSkillPreferences({
    ...base,
    ...profileSkills[profile],
    ...doctrineSkills[doctrine],
  });
}

function normalizeSkillPreferences(
  preferences: Partial<Record<StrategicSkill, number>>,
): Partial<Record<StrategicSkill, number>> {
  const normalized: Partial<Record<StrategicSkill, number>> = {};
  for (const skill of strategicSkills) {
    const value = preferences[skill];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      normalized[skill] = Math.min(1, Math.max(0, Math.round(value * 100) / 100));
    }
  }
  return normalized;
}

function defaultPersonality(profile: AgentStrategyProfile): string {
  switch (profile) {
    case "aggressive":
      return "Expand quickly, pressure rivals, and attack when the odds are favorable.";
    case "defensive":
      return "Build a durable economy and protect borders before taking risks.";
    case "diplomatic":
      return "Seek alliances, support partners, and use pressure only when needed.";
    case "opportunistic":
      return "Take low-risk growth and pivot quickly when an opening appears.";
  }
}

function cleanText(
  value: unknown,
  options: { label: string; min: number; max: number },
): string {
  if (typeof value !== "string") {
    if (options.min === 0 && value === undefined) return "";
    throw new Error(`${options.label} must be text`);
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < options.min || cleaned.length > options.max) {
    throw new Error(
      `${options.label} must be ${options.min}-${options.max} characters`,
    );
  }
  if (/[<>]/.test(cleaned)) {
    throw new Error(`${options.label} cannot contain angle brackets`);
  }
  return cleaned;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${label} must be one of ${allowed.join(", ")}`);
}

function externalHttpProvider(input: CreateProxyWarNationInput) {
  if (typeof input.endpointUrl !== "string") {
    throw new Error("External agent URL must be text");
  }
  let endpointUrl: string;
  try {
    endpointUrl = normalizeExternalAgentEndpointUrl(input.endpointUrl).url;
  } catch {
    throw new Error("External agent URL must be a valid http or https URL");
  }
  if (input.endpointToken !== undefined && input.endpointTokenEnv !== undefined) {
    throw new Error(
      "External agent token can be provided directly or through env, not both",
    );
  }
  const tokenReference =
    input.endpointTokenEnv !== undefined
      ? normalizeExternalAgentTokenInput(
          `env:${String(input.endpointTokenEnv)}`,
          "External agent token env",
        )
      : normalizeExternalAgentTokenInput(
          input.endpointToken ?? "",
          "External agent token",
        );
  const timeoutMs = optionalTimeoutMs(input.endpointTimeoutMs);
  return {
    provider: "external-http" as const,
    endpointUrl,
    ...tokenReference,
    ...(timeoutMs !== null ? { timeoutMs } : {}),
  };
}

function externalRelayProvider(input: CreateProxyWarNationInput) {
  if (typeof input.relayBaseUrl !== "string") {
    throw new Error("Managed relay base URL must be text");
  }
  if (typeof input.relaySessionID !== "string") {
    throw new Error("Managed relay session ID must be text");
  }
  let relayBaseUrl: string;
  try {
    const url = new URL(input.relayBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    relayBaseUrl = url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("Managed relay base URL must be a valid http or https URL");
  }
  const sessionID = input.relaySessionID.trim();
  if (!/^relay_[a-f0-9]{24}$/i.test(sessionID)) {
    throw new Error("Managed relay session ID is invalid");
  }
  if (input.relayToken !== undefined && input.relayTokenEnv !== undefined) {
    throw new Error(
      "Managed relay token can be provided directly or through env, not both",
    );
  }
  const tokenReference =
    input.relayTokenEnv !== undefined
      ? normalizeExternalAgentTokenInput(
          `env:${String(input.relayTokenEnv)}`,
          "Managed relay token env",
        )
      : normalizeExternalAgentTokenInput(
          input.relayToken ?? "",
          "Managed relay token",
        );
  const timeoutMs = optionalTimeoutMs(input.relayTimeoutMs);
  return {
    provider: "external-relay" as const,
    relayBaseUrl,
    sessionID,
    ...tokenReference,
    ...(timeoutMs !== null ? { timeoutMs } : {}),
  };
}

async function protectExternalAgentToken(
  input: CreateProxyWarNationInput,
  options: { secretStorePath?: string; label?: string },
): Promise<CreateProxyWarNationInput> {
  if (input.agentMode === "external-relay" && typeof input.relayToken === "string") {
    const token = input.relayToken.trim();
    if (
      token === "" ||
      token.toLowerCase().startsWith("env:") ||
      token.toLowerCase().startsWith("secret:")
    ) {
      return input;
    }
    const reference = await storeExternalAgentTokenSecret(token, {
      storePath: options.secretStorePath,
      label: options.label,
    });
    return {
      ...input,
      relayToken:
        reference.tokenSecret === undefined
          ? undefined
          : `secret:${reference.tokenSecret}`,
    };
  }
  if (input.agentMode !== "external-http" || typeof input.endpointToken !== "string") {
    return input;
  }
  const token = input.endpointToken.trim();
  if (
    token === "" ||
    token.toLowerCase().startsWith("env:") ||
    token.toLowerCase().startsWith("secret:")
  ) {
    return input;
  }
  const reference = await storeExternalAgentTokenSecret(token, {
    storePath: options.secretStorePath,
    label: options.label,
  });
  return {
    ...input,
    endpointToken:
      reference.tokenSecret === undefined
        ? undefined
        : `secret:${reference.tokenSecret}`,
  };
}

function optionalTimeoutMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const timeoutMs =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 250 ||
    timeoutMs > 180_000
  ) {
    throw new Error("External agent timeout must be 250-180000 ms");
  }
  return timeoutMs;
}

function safePathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "nation"
  );
}
