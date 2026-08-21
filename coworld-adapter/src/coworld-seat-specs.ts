import { createHash } from "node:crypto";

const proxyWarUsernameInvalidCharacters = /[^a-zA-Z0-9_ üÜ.]+/gu;
const coworldPlayerUUIDNamespace = Buffer.from(
  "6ba7b8109dad11d180b400c04fd430c8",
  "hex",
);
const maximumUsernameCollisionAttempts = 4_096;

export type CoworldSeatSpec = {
  username: string;
  profile: "opportunistic";
  persistentID: string;
};

export function proxyWarUsernames(
  players: Array<{ name: string }>,
  maxLength: number,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 3) {
    throw new Error("Proxy War usernames require an integer maxLength >= 3");
  }
  const authoredNameOccurrences = new Map<string, number>();
  const entries = players.map((player, index) => {
    const authoredNameOccurrence =
      (authoredNameOccurrences.get(player.name) ?? 0) + 1;
    authoredNameOccurrences.set(player.name, authoredNameOccurrence);
    const normalized = player.name
      .replace(proxyWarUsernameInvalidCharacters, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return {
      authoredName: player.name,
      authoredNameOccurrence,
      index,
      normalized,
    };
  });

  const usernames = new Array<string>(players.length);
  const seen = new Set<string>();
  const stableEntries = [...entries].sort(
    (left, right) =>
      compareCodeUnits(left.authoredName, right.authoredName) ||
      left.authoredNameOccurrence - right.authoredNameOccurrence,
  );
  for (
    let stableIndex = 0;
    stableIndex < stableEntries.length;
    stableIndex += 1
  ) {
    const entry = stableEntries[stableIndex];
    const fallback = `Coworld Player ${stableIndex + 1}`;
    const base = (entry.normalized.length >= 3 ? entry.normalized : fallback)
      .slice(0, maxLength)
      .trim();
    const initial = base.length >= 3 ? base : fallback.slice(0, maxLength);
    const username = uniqueProxyWarUsername(
      initial,
      stableIndex + 1,
      maxLength,
      seen,
    );
    seen.add(username);
    usernames[entry.index] = username;
  }
  return usernames;
}

/**
 * Preserve the historical seat-number suffix when possible, but keep walking
 * upward if that candidate was already claimed by an authored name or an
 * earlier collision (for example Foo 3 / Foo / Foo).
 */
function uniqueProxyWarUsername(
  initial: string,
  firstSuffix: number,
  maxLength: number,
  seen: ReadonlySet<string>,
): string {
  if (!seen.has(initial)) return initial;

  for (
    let attempt = 0;
    attempt < maximumUsernameCollisionAttempts;
    attempt += 1
  ) {
    const suffixNumber = firstSuffix + attempt;
    const suffix = ` ${suffixNumber}`;
    const prefix = initial
      .slice(0, Math.max(0, maxLength - suffix.length))
      .trim();
    const suffixedCandidate = `${prefix}${suffix}`.slice(0, maxLength).trim();
    const discriminator = suffixNumber.toString(36).toUpperCase();
    const compactCandidate = `${initial.slice(
      0,
      Math.max(0, maxLength - discriminator.length),
    )}${discriminator}`
      .slice(0, maxLength)
      .trim();
    const candidate =
      suffixedCandidate.length >= 3 ? suffixedCandidate : compactCandidate;
    if (candidate.length >= 3 && !seen.has(candidate)) return candidate;
  }
  throw new Error(
    `Unable to derive a unique Proxy War username within ${maximumUsernameCollisionAttempts} deterministic attempts`,
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** RFC 4122 UUIDv5 using the DNS namespace and a ProxyWar-specific name. */
export function deterministicCoworldPersistentID(
  authoredName: string,
  authoredNameOccurrence = 1,
): string {
  const digest = createHash("sha1")
    .update(coworldPlayerUUIDNamespace)
    .update("proxywar-coworld-player-v1:", "utf8")
    .update(authoredName, "utf8")
    .update(`\u0000${authoredNameOccurrence}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable ProxyWar UUID derived from Coworld's immutable cross-policy player id. */
export function deterministicCoworldPlayerPersistentID(
  coworldPlayerID: string,
): string {
  if (typeof coworldPlayerID !== "string" || coworldPlayerID.length === 0) {
    throw new Error("Coworld player id must be a non-empty string");
  }
  const digest = createHash("sha1")
    .update(coworldPlayerUUIDNamespace)
    .update("proxywar-coworld-player-id-v2:", "utf8")
    .update(coworldPlayerID, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function competitiveSeatSpecs(
  players: Array<{ name: string }>,
  maxLength: number,
  createPersistentID: (
    authoredName: string,
    authoredNameOccurrence: number,
  ) => string = deterministicCoworldPersistentID,
  coworldPlayerIDs?: readonly string[] | null,
): CoworldSeatSpec[] {
  if (
    coworldPlayerIDs !== undefined &&
    coworldPlayerIDs !== null &&
    coworldPlayerIDs.length !== players.length
  ) {
    throw new Error("Coworld player ids must align with player seats");
  }
  const usernames = proxyWarUsernames(players, maxLength);
  const authoredNameOccurrences = new Map<string, number>();
  return usernames.map((username, index) => {
    const authoredName = players[index].name;
    const authoredNameOccurrence =
      (authoredNameOccurrences.get(authoredName) ?? 0) + 1;
    authoredNameOccurrences.set(authoredName, authoredNameOccurrence);
    return {
      username,
      profile: "opportunistic",
      persistentID:
        coworldPlayerIDs === undefined || coworldPlayerIDs === null
          ? createPersistentID(authoredName, authoredNameOccurrence)
          : deterministicCoworldPlayerPersistentID(coworldPlayerIDs[index]),
    };
  });
}
