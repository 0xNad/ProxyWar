import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AgentProfile,
  AgentRegistryFileSchema,
  AgentVersion,
  AgentVersionRegistryFileSchema,
  BuilderProfile,
  BuilderRegistryFileSchema,
} from "./IdentitySchemas";

/**
 * Tracked, human-readable identity registry files — version-controlled JSON,
 * validated by Zod, no database (spec Stage 1 item 3: "do not add a
 * database for a small curated registry"). Lives under `resources/` beside
 * the repo's other tracked reference data (`countries.json`, `flags/`) —
 * the closest existing precedent for "small, curated, per-entity JSON the
 * server reads at runtime and an operator hand-edits occasionally".
 */
export const defaultIdentityRegistryDir = path.join(
  process.cwd(),
  "resources",
  "identity",
);

export const defaultBuilderRegistryPath = (dir = defaultIdentityRegistryDir) =>
  path.join(dir, "builders.json");
export const defaultAgentRegistryPath = (dir = defaultIdentityRegistryDir) =>
  path.join(dir, "agents.json");
export const defaultAgentVersionRegistryPath = (
  dir = defaultIdentityRegistryDir,
) => path.join(dir, "versions.json");
export const defaultEmblemDir = (dir = defaultIdentityRegistryDir) =>
  path.join(dir, "emblems");

export class IdentityRegistryError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = "IdentityRegistryError";
  }
}

async function readJson(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new IdentityRegistryError(
      filePath,
      `could not read registry file: ${(error as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new IdentityRegistryError(
      filePath,
      `not valid JSON: ${(error as Error).message}`,
    );
  }
}

export async function loadBuilderRegistry(
  filePath = defaultBuilderRegistryPath(),
): Promise<readonly BuilderProfile[]> {
  const parsed = BuilderRegistryFileSchema.safeParse(await readJson(filePath));
  if (!parsed.success) {
    throw new IdentityRegistryError(filePath, parsed.error.message);
  }
  return parsed.data.builders;
}

export async function loadAgentRegistry(
  filePath = defaultAgentRegistryPath(),
): Promise<readonly AgentProfile[]> {
  const parsed = AgentRegistryFileSchema.safeParse(await readJson(filePath));
  if (!parsed.success) {
    throw new IdentityRegistryError(filePath, parsed.error.message);
  }
  return parsed.data.agents;
}

export async function loadAgentVersionRegistry(
  filePath = defaultAgentVersionRegistryPath(),
): Promise<readonly AgentVersion[]> {
  const parsed = AgentVersionRegistryFileSchema.safeParse(
    await readJson(filePath),
  );
  if (!parsed.success) {
    throw new IdentityRegistryError(filePath, parsed.error.message);
  }
  return parsed.data.versions;
}

export interface IdentityRegistrySnapshot {
  builders: readonly BuilderProfile[];
  agents: readonly AgentProfile[];
  versions: readonly AgentVersion[];
}

/** Loads and validates all three registry files together — the shape every consumer (CLIs, the mirror writer) actually wants. */
export async function loadIdentityRegistrySnapshot(
  dir = defaultIdentityRegistryDir,
): Promise<IdentityRegistrySnapshot> {
  const [builders, agents, versions] = await Promise.all([
    loadBuilderRegistry(defaultBuilderRegistryPath(dir)),
    loadAgentRegistry(defaultAgentRegistryPath(dir)),
    loadAgentVersionRegistry(defaultAgentVersionRegistryPath(dir)),
  ]);
  return { builders, agents, versions };
}

/** Pretty-printed, trailing-newline JSON — matches this repo's other tracked JSON (see `deploy/coworld-league-retention-pins.json`) so diffs stay reviewable. */
function serializeRegistryFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function saveAgentRegistry(
  agents: readonly AgentProfile[],
  filePath = defaultAgentRegistryPath(),
): Promise<void> {
  const file = AgentRegistryFileSchema.parse({ schemaVersion: 1, agents });
  await fs.writeFile(filePath, serializeRegistryFile(file), "utf8");
}

export async function saveBuilderRegistry(
  builders: readonly BuilderProfile[],
  filePath = defaultBuilderRegistryPath(),
): Promise<void> {
  const file = BuilderRegistryFileSchema.parse({
    schemaVersion: 1,
    builders,
  });
  await fs.writeFile(filePath, serializeRegistryFile(file), "utf8");
}

export async function saveAgentVersionRegistry(
  versions: readonly AgentVersion[],
  filePath = defaultAgentVersionRegistryPath(),
): Promise<void> {
  const file = AgentVersionRegistryFileSchema.parse({
    schemaVersion: 1,
    versions,
  });
  await fs.writeFile(filePath, serializeRegistryFile(file), "utf8");
}
