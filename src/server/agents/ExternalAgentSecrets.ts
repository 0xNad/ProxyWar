import { randomUUID } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

export interface ExternalAgentTokenReference {
  token?: string;
  tokenEnv?: string;
  tokenSecret?: string;
}

export interface ExternalAgentSecretStoreOptions {
  storePath?: string;
  now?: () => Date;
}

interface ExternalAgentSecretStoreFile {
  schemaVersion: 1;
  secrets: Record<
    string,
    {
      token: string;
      createdAt: string;
      label?: string;
    }
  >;
}

export const defaultExternalAgentSecretStorePath = path.join(
  process.cwd(),
  "artifacts",
  "proxywar",
  "secrets",
  "external-agent-tokens.json",
);

export function normalizeExternalAgentTokenInput(
  value: unknown,
  label = "External agent token",
): ExternalAgentTokenReference {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be text`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return {};
  }
  if (trimmed.toLowerCase().startsWith("env:")) {
    const tokenEnv = trimmed.slice("env:".length).trim();
    assertSafeEnvName(tokenEnv, label);
    return { tokenEnv };
  }
  if (trimmed.toLowerCase().startsWith("secret:")) {
    const tokenSecret = trimmed.slice("secret:".length).trim();
    assertSafeSecretID(tokenSecret, label);
    return { tokenSecret };
  }
  if (trimmed.length > 512) {
    throw new Error(`${label} must be at most 512 characters`);
  }
  return { token: trimmed };
}

export function validateExternalAgentTokenReference(
  value: {
    token?: unknown;
    tokenEnv?: unknown;
    tokenSecret?: unknown;
  },
  source: string,
): ExternalAgentTokenReference {
  const definedCount = [value.token, value.tokenEnv, value.tokenSecret].filter(
    (field) => field !== undefined,
  ).length;
  if (definedCount > 1) {
    throw new Error(
      `${source} provider can define only one of token, tokenEnv, or tokenSecret`,
    );
  }
  if (value.tokenEnv !== undefined) {
    if (typeof value.tokenEnv !== "string") {
      throw new Error(`${source} provider.tokenEnv must be a string`);
    }
    const tokenEnv = value.tokenEnv.trim();
    assertSafeEnvName(tokenEnv, `${source} provider.tokenEnv`);
    return { tokenEnv };
  }
  if (value.tokenSecret !== undefined) {
    if (typeof value.tokenSecret !== "string") {
      throw new Error(`${source} provider.tokenSecret must be a string`);
    }
    const tokenSecret = value.tokenSecret.trim();
    assertSafeSecretID(tokenSecret, `${source} provider.tokenSecret`);
    return { tokenSecret };
  }
  if (value.token !== undefined) {
    return normalizeExternalAgentTokenInput(
      value.token,
      `${source} provider.token`,
    );
  }
  return {};
}

export function resolveExternalAgentToken(
  reference: ExternalAgentTokenReference | undefined,
  env: Record<string, string | undefined> = process.env,
  options: ExternalAgentSecretStoreOptions = {},
): string | undefined {
  if (reference?.token !== undefined && reference.token.trim() !== "") {
    return reference.token.trim();
  }
  if (reference?.tokenEnv !== undefined) {
    const value = env[reference.tokenEnv];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `External agent token env ${reference.tokenEnv} is not configured`,
      );
    }
    return value.trim();
  }
  if (reference?.tokenSecret !== undefined) {
    return resolveStoredExternalAgentToken(reference.tokenSecret, options);
  }
  return undefined;
}

export async function storeExternalAgentTokenSecret(
  token: string,
  options: ExternalAgentSecretStoreOptions & { label?: string } = {},
): Promise<ExternalAgentTokenReference> {
  const cleaned = token.trim();
  if (cleaned === "") {
    return {};
  }
  if (cleaned.length > 512) {
    throw new Error("External agent token must be at most 512 characters");
  }
  const storePath = options.storePath ?? defaultExternalAgentSecretStorePath;
  const store = await readSecretStore(storePath);
  const tokenSecret = `agent_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  store.secrets[tokenSecret] = {
    token: cleaned,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    ...(options.label !== undefined ? { label: options.label.slice(0, 80) } : {}),
  };
  await writeSecretStore(storePath, store);
  return { tokenSecret };
}

function resolveStoredExternalAgentToken(
  tokenSecret: string,
  options: ExternalAgentSecretStoreOptions,
): string {
  assertSafeSecretID(tokenSecret, "External agent token secret");
  const storePath = options.storePath ?? defaultExternalAgentSecretStorePath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
  } catch {
    throw new Error(`External agent token secret ${tokenSecret} is not configured`);
  }
  const store = normalizeSecretStore(parsed);
  const entry = store.secrets[tokenSecret];
  if (entry === undefined || entry.token.trim() === "") {
    throw new Error(`External agent token secret ${tokenSecret} is not configured`);
  }
  return entry.token.trim();
}

async function readSecretStore(
  storePath: string,
): Promise<ExternalAgentSecretStoreFile> {
  try {
    return normalizeSecretStore(
      JSON.parse(await fsp.readFile(storePath, "utf8")) as unknown,
    );
  } catch {
    return { schemaVersion: 1, secrets: {} };
  }
}

async function writeSecretStore(
  storePath: string,
  store: ExternalAgentSecretStoreFile,
): Promise<void> {
  await fsp.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsp.rename(tmpPath, storePath);
  await fsp.chmod(storePath, 0o600).catch(() => {});
}

function normalizeSecretStore(value: unknown): ExternalAgentSecretStoreFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: 1, secrets: {} };
  }
  const record = value as Record<string, unknown>;
  const rawSecrets =
    record.secrets !== null &&
    typeof record.secrets === "object" &&
    !Array.isArray(record.secrets)
      ? (record.secrets as Record<string, unknown>)
      : {};
  const secrets: ExternalAgentSecretStoreFile["secrets"] = {};
  for (const [id, rawEntry] of Object.entries(rawSecrets)) {
    if (!isSafeSecretID(id)) {
      continue;
    }
    if (
      rawEntry === null ||
      typeof rawEntry !== "object" ||
      Array.isArray(rawEntry)
    ) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.token !== "string" || entry.token.trim() === "") {
      continue;
    }
    secrets[id] = {
      token: entry.token.slice(0, 512),
      createdAt:
        typeof entry.createdAt === "string"
          ? entry.createdAt
          : new Date(0).toISOString(),
      ...(typeof entry.label === "string" ? { label: entry.label.slice(0, 80) } : {}),
    };
  }
  return { schemaVersion: 1, secrets };
}

function assertSafeEnvName(value: string, label: string): void {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error(
      `${label} must be an env reference like env:PROXYWAR_AGENT_TOKEN`,
    );
  }
}

function assertSafeSecretID(value: string, label: string): void {
  if (!isSafeSecretID(value)) {
    throw new Error(`${label} must be a secret reference like secret:agent_abc123`);
  }
}

function isSafeSecretID(value: string): boolean {
  return /^agent_[a-z0-9_-]{8,80}$/.test(value);
}
