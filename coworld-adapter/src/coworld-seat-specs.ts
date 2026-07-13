import { randomUUID } from "node:crypto";

const proxyWarUsernameInvalidCharacters = /[^a-zA-Z0-9_ üÜ.]+/gu;

export type CoworldSeatSpec = {
  username: string;
  profile: "opportunistic";
  persistentID: string;
};

export function proxyWarUsernames(
  players: Array<{ name: string }>,
  maxLength: number,
): string[] {
  const seen = new Set<string>();
  return players.map((player, index) => {
    const fallback = `Coworld Player ${index + 1}`;
    const normalized = player.name
      .replace(proxyWarUsernameInvalidCharacters, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const base = (normalized.length >= 3 ? normalized : fallback)
      .slice(0, maxLength)
      .trim();
    let username = base.length >= 3 ? base : fallback.slice(0, maxLength);
    if (seen.has(username)) {
      const suffix = ` ${index + 1}`;
      username = `${username.slice(0, maxLength - suffix.length).trim()}${suffix}`;
    }
    seen.add(username);
    return username;
  });
}

export function competitiveSeatSpecs(
  players: Array<{ name: string }>,
  maxLength: number,
  createPersistentID: () => string = randomUUID,
): CoworldSeatSpec[] {
  const usernames = proxyWarUsernames(players, maxLength);
  return usernames.map((username) => ({
    username,
    profile: "opportunistic",
    persistentID: createPersistentID(),
  }));
}
