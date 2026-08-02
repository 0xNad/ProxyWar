import { emblemAssetPath } from "./IdentityEmblems";
import { IdentityRegistrySnapshot } from "./IdentityRegistry";

/**
 * Everything `identity:validate` checks beyond the Zod schema parse that
 * already runs on load (`IdentityRegistry.ts`): referential integrity
 * between the three registries, slug/short-code/id uniqueness and
 * consistency, and a defense-in-depth scan for secret-shaped strings.
 * Zod's `.strict()` object schemas already reject any field this module
 * doesn't know about; this is the second layer, not the only one.
 */

export interface IdentityValidationResult {
  errors: readonly string[];
  warnings: readonly string[];
}

/** Common secret-shaped prefixes/markers. Not exhaustive — a heuristic second layer behind `.strict()` schemas, never the only defense. */
const SECRET_MARKERS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

function scanStringForSecrets(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value === "string") {
    for (const marker of SECRET_MARKERS) {
      if (marker.test(value)) {
        errors.push(`${path}: value matches a secret-shaped pattern (${marker.source})`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanStringForSecrets(entry, `${path}[${index}]`, errors),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanStringForSecrets(entry, `${path}.${key}`, errors);
    }
  }
}

export function validateIdentityRegistrySnapshot(
  snapshot: IdentityRegistrySnapshot,
): IdentityValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const builderIds = new Set(snapshot.builders.map((builder) => builder.id));
  const builderSlugs = new Set<string>();
  for (const builder of snapshot.builders) {
    if (builder.id !== `bld_${builder.slug}`) {
      errors.push(`builder ${builder.id}: id does not match bld_<slug> for slug "${builder.slug}"`);
    }
    if (builderSlugs.has(builder.slug)) {
      errors.push(`builder slug "${builder.slug}" is used by more than one BuilderProfile`);
    }
    builderSlugs.add(builder.slug);
  }

  const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
  const agentSlugs = new Set<string>();
  const shortCodes = new Map<string, string>();
  const matchedPlayerNames = new Map<string, string>();
  for (const agent of snapshot.agents) {
    if (agent.id !== `agt_${agent.slug}`) {
      errors.push(`agent ${agent.id}: id does not match agt_<slug> for slug "${agent.slug}"`);
    }
    if (agentSlugs.has(agent.slug)) {
      errors.push(`agent slug "${agent.slug}" is used by more than one AgentProfile`);
    }
    agentSlugs.add(agent.slug);

    const existingShortCodeOwner = shortCodes.get(agent.shortCode);
    if (existingShortCodeOwner !== undefined) {
      errors.push(
        `short code "${agent.shortCode}" collides between ${existingShortCodeOwner} and ${agent.id}`,
      );
    }
    for (const [otherCode, otherAgentId] of shortCodes) {
      if (otherCode !== agent.shortCode && (otherCode.startsWith(agent.shortCode) || agent.shortCode.startsWith(otherCode))) {
        warnings.push(
          `short code "${agent.shortCode}" (${agent.id}) is a prefix of "${otherCode}" (${otherAgentId}) — visually confusable, consider a longer or more distinct code`,
        );
      }
    }
    shortCodes.set(agent.shortCode, agent.id);

    const existingPlayerNameOwner = matchedPlayerNames.get(
      agent.policyMatchRule.playerName,
    );
    if (existingPlayerNameOwner !== undefined) {
      errors.push(
        `live player "${agent.policyMatchRule.playerName}" is matched by both ${existingPlayerNameOwner} and ${agent.id}`,
      );
    }
    matchedPlayerNames.set(agent.policyMatchRule.playerName, agent.id);

    if (agent.builderId !== null && !builderIds.has(agent.builderId)) {
      errors.push(`agent ${agent.id}: builderId "${agent.builderId}" has no matching BuilderProfile`);
    }
    if (agent.builderId === null && agent.status === "verified") {
      errors.push(`agent ${agent.id}: status is "verified" but builderId is null`);
    }
    if (agent.emblem.seed !== agent.id) {
      errors.push(`agent ${agent.id}: emblem.seed "${agent.emblem.seed}" must equal the agent's own id`);
    }
    if (agent.emblem.assetPath !== emblemAssetPath(agent.id)) {
      errors.push(
        `agent ${agent.id}: emblem.assetPath "${agent.emblem.assetPath}" does not match the expected path "${emblemAssetPath(agent.id)}"`,
      );
    }
  }

  const versionIds = new Set<string>();
  for (const version of snapshot.versions) {
    if (versionIds.has(version.id)) {
      errors.push(`version id "${version.id}" is used by more than one AgentVersion`);
    }
    versionIds.add(version.id);

    if (!agentIds.has(version.agentId)) {
      errors.push(`version ${version.id}: agentId "${version.agentId}" has no matching AgentProfile`);
    }
    if (!version.id.startsWith(`agtv_`) || !version.id.includes(`_v`)) {
      errors.push(`version ${version.id}: id does not match agtv_<agent-slug>_v<version>`);
    }
    const owningAgent = snapshot.agents.find((agent) => agent.id === version.agentId);
    if (owningAgent !== undefined && !version.id.startsWith(`agtv_${owningAgent.slug}_`)) {
      errors.push(
        `version ${version.id}: id's agent-slug segment does not match owning agent ${owningAgent.id}'s slug "${owningAgent.slug}"`,
      );
    }
  }

  scanStringForSecrets(snapshot, "registry", errors);

  return { errors, warnings };
}
