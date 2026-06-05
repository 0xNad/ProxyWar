import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  AgentBrainType,
  AgentStrategyProfile,
  agentStrategyProfiles,
} from "./AgentTypes";
import { AgentSpec } from "./AgentLeagueMatch";
import { normalizeExternalAgentEndpointUrl } from "./ExternalAgentNetworkPolicy";
import { validateExternalAgentTokenReference } from "./ExternalAgentSecrets";

export type AgentManifestBrainType =
  | AgentBrainType
  | "planner"
  | "planner-codex-cli";

export type AgentManifestProvider =
  | {
      provider: "mock-llm" | "codex-cli" | "openai" | "rule";
      model?: string;
    }
  | {
      provider: "external-http";
      endpointUrl: string;
      token?: string;
      tokenEnv?: string;
      tokenSecret?: string;
      timeoutMs?: number;
    }
  | {
      provider: "external-relay";
      relayBaseUrl: string;
      sessionID: string;
      token?: string;
      tokenEnv?: string;
      tokenSecret?: string;
      timeoutMs?: number;
    };

export interface AgentManifest {
  schemaVersion: 1;
  agentName: string;
  profile: AgentStrategyProfile;
  brainType: AgentManifestBrainType;
  plannerExecutorMode?: boolean;
  personality?: string;
  policyChangelog?: string;
  observationPolicy?: "default" | "compact" | "full";
  skillPreferences?: Partial<Record<string, number>>;
  provider?: AgentManifestProvider;
}

export const proxyWarGameUsernameMaxLength = 27;

export interface LoadAgentManifestsOptions {
  minAgents?: number;
  maxAgents?: number;
}

export async function loadAgentManifestsFromDirectory(
  directory: string,
  options: LoadAgentManifestsOptions = {},
): Promise<AgentManifest[]> {
  const minAgents = options.minAgents ?? 3;
  const maxAgents = options.maxAgents ?? 8;
  const entries = await fs.readdir(directory);
  const files = entries
    .filter((entry) => entry.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  const manifests = await Promise.all(
    files.map(async (file) =>
      validateAgentManifest(
        JSON.parse(await fs.readFile(path.join(directory, file), "utf8")),
        file,
      ),
    ),
  );
  if (manifests.length < minAgents || manifests.length > maxAgents) {
    throw new Error(
      `AI league manifest directories must contain ${minAgents} to ${maxAgents} agents`,
    );
  }
  return manifests;
}

export function validateAgentManifest(
  value: unknown,
  source = "manifest",
): AgentManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object`);
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`${source} schemaVersion must be 1`);
  }
  if (typeof manifest.agentName !== "string" || manifest.agentName.trim() === "") {
    throw new Error(`${source} agentName must be a non-empty string`);
  }
  if (!agentStrategyProfiles.includes(manifest.profile as AgentStrategyProfile)) {
    throw new Error(`${source} profile is invalid`);
  }
  if (!isManifestBrainType(manifest.brainType)) {
    throw new Error(`${source} brainType is invalid`);
  }
  if (
    manifest.personality !== undefined &&
    typeof manifest.personality !== "string"
  ) {
    throw new Error(`${source} personality must be a string when provided`);
  }
  if (
    manifest.policyChangelog !== undefined &&
    typeof manifest.policyChangelog !== "string"
  ) {
    throw new Error(`${source} policyChangelog must be a string when provided`);
  }
  if (
    manifest.observationPolicy !== undefined &&
    manifest.observationPolicy !== "default" &&
    manifest.observationPolicy !== "compact" &&
    manifest.observationPolicy !== "full"
  ) {
    throw new Error(`${source} observationPolicy is invalid`);
  }
  if (
    manifest.skillPreferences !== undefined &&
    (manifest.skillPreferences === null ||
      typeof manifest.skillPreferences !== "object" ||
      Array.isArray(manifest.skillPreferences))
  ) {
    throw new Error(`${source} skillPreferences must be an object`);
  }
  return {
    schemaVersion: 1,
    agentName: manifest.agentName.trim().slice(0, 80),
    profile: manifest.profile as AgentStrategyProfile,
    brainType: manifest.brainType,
    plannerExecutorMode:
      typeof manifest.plannerExecutorMode === "boolean"
        ? manifest.plannerExecutorMode
        : manifest.brainType === "planner" ||
          manifest.brainType === "planner-codex-cli" ||
          manifest.brainType === "planner-executor",
    personality: manifest.personality,
    policyChangelog:
      typeof manifest.policyChangelog === "string"
        ? manifest.policyChangelog.trim().slice(0, 600)
        : undefined,
    observationPolicy: manifest.observationPolicy as
      | AgentManifest["observationPolicy"]
      | undefined,
    skillPreferences: manifest.skillPreferences as AgentManifest["skillPreferences"],
    provider: validateProvider(manifest.provider, source),
  };
}

export function agentManifestToSpec(manifest: AgentManifest): AgentSpec {
  return {
    username: manifest.agentName.slice(0, proxyWarGameUsernameMaxLength),
    profile: manifest.profile,
    persistentID: randomUUID(),
  };
}

function validateProvider(
  value: unknown,
  source: string,
): AgentManifest["provider"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} provider must be an object when provided`);
  }
  const provider = value as Record<string, unknown>;
  if (
    provider.provider !== "mock-llm" &&
    provider.provider !== "codex-cli" &&
    provider.provider !== "openai" &&
    provider.provider !== "rule" &&
    provider.provider !== "external-http" &&
    provider.provider !== "external-relay"
  ) {
    throw new Error(`${source} provider.provider is invalid`);
  }
  if (provider.provider === "external-http") {
    if (typeof provider.endpointUrl !== "string") {
      throw new Error(`${source} provider.endpointUrl must be a string`);
    }
    const endpointUrl = validateEndpointUrl(provider.endpointUrl, source);
    const tokenReference = validateExternalAgentTokenReference(provider, source);
    if (provider.timeoutMs !== undefined) {
      if (
        typeof provider.timeoutMs !== "number" ||
        !Number.isInteger(provider.timeoutMs) ||
        provider.timeoutMs < 250 ||
        provider.timeoutMs > 180_000
      ) {
        throw new Error(
          `${source} provider.timeoutMs must be an integer from 250 to 180000`,
        );
      }
    }
    return {
      provider: "external-http",
      endpointUrl,
      ...tokenReference,
      ...(provider.timeoutMs !== undefined
        ? { timeoutMs: provider.timeoutMs }
        : {}),
    };
  }
  if (provider.provider === "external-relay") {
    if (typeof provider.relayBaseUrl !== "string") {
      throw new Error(`${source} provider.relayBaseUrl must be a string`);
    }
    if (typeof provider.sessionID !== "string") {
      throw new Error(`${source} provider.sessionID must be a string`);
    }
    const relayBaseUrl = validateRelayBaseUrl(provider.relayBaseUrl, source);
    const sessionID = provider.sessionID.trim();
    if (!/^relay_[a-f0-9]{24}$/i.test(sessionID)) {
      throw new Error(`${source} provider.sessionID is invalid`);
    }
    const tokenReference = validateExternalAgentTokenReference(provider, source);
    if (provider.timeoutMs !== undefined) {
      if (
        typeof provider.timeoutMs !== "number" ||
        !Number.isInteger(provider.timeoutMs) ||
        provider.timeoutMs < 250 ||
        provider.timeoutMs > 180_000
      ) {
        throw new Error(
          `${source} provider.timeoutMs must be an integer from 250 to 180000`,
        );
      }
    }
    return {
      provider: "external-relay",
      relayBaseUrl,
      sessionID,
      ...tokenReference,
      ...(provider.timeoutMs !== undefined
        ? { timeoutMs: provider.timeoutMs }
        : {}),
    };
  }
  if (provider.model !== undefined && typeof provider.model !== "string") {
    throw new Error(`${source} provider.model must be a string when provided`);
  }
  return {
    provider: provider.provider,
    model: provider.model,
  } as AgentManifest["provider"];
}

function isManifestBrainType(value: unknown): value is AgentManifestBrainType {
  return (
    value === "rule" ||
    value === "mock-llm" ||
    value === "real-llm" ||
    value === "codex-cli" ||
    value === "external-http" ||
    value === "external-relay" ||
    value === "planner-executor" ||
    value === "planner" ||
    value === "planner-codex-cli" ||
    value === "llm"
  );
}

function validateRelayBaseUrl(value: string, source: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${source} provider.relayBaseUrl must be a valid URL`);
  }
}

function validateEndpointUrl(value: string, source: string): string {
  try {
    return normalizeExternalAgentEndpointUrl(value).url;
  } catch {
    throw new Error(`${source} provider.endpointUrl must be a valid URL`);
  }
}
