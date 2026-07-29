/**
 * Shared secret authenticating the ONE cross-origin call this codebase makes
 * from the platform account origin (wagering off) INTO betting (wagering
 * on): `GET /api/internal/players/:name/betting-profile` — betting's
 * read-only projection of a linked bettor's public points stats, consumed
 * by the platform's `/api/players/:name` so a profile page can show betting
 * stats without the platform ever touching `ReplayPremierePointsLedger`
 * directly. Betting stays the ledger's sole writer AND its sole direct
 * reader; this token is what lets the platform ask betting instead.
 *
 * Configured identically on both origins (same value, same precedence as
 * `GithubOAuthClient`'s client secret): `_TOKEN_FILE` wins when set — a path
 * to a `0600`, self-owned file, kept out of `ps eww <pid>` — falling back to
 * the inline `_TOKEN` only for local dev/test convenience. Unset on EITHER
 * side means this feature cleanly does not exist there: betting never mounts
 * the route, and the platform never attempts the call — matching "unset env
 * means the route doesn't exist" everywhere else in this codebase (GitHub
 * sign-in, the points/leaderboard surfaces).
 */
import { promises as fs } from "node:fs";

export const BETTING_PROFILE_TOKEN_ENV = "PROXYWAR_BETTING_PROFILE_TOKEN" as const;
export const BETTING_PROFILE_TOKEN_FILE_ENV =
  "PROXYWAR_BETTING_PROFILE_TOKEN_FILE" as const;

/**
 * Resolves the shared token. An unreadable, group/world-accessible, or
 * not-a-regular-file `_TOKEN_FILE` is treated exactly like an unset secret —
 * never thrown — logging only a path, never file content or a raw fs error
 * that could embed it.
 */
export async function resolveBettingProfileServiceToken(
  environment: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const tokenFilePath = environment[BETTING_PROFILE_TOKEN_FILE_ENV]?.trim();
  if (tokenFilePath !== undefined && tokenFilePath !== "") {
    try {
      // lstat, not stat: a symlink pointing at a world-readable file must
      // not launder the permission check below.
      const stats = await fs.lstat(tokenFilePath);
      if (!stats.isFile()) {
        console.error(
          `Betting profile service token path is not a regular file: ${tokenFilePath}`,
        );
        return null;
      }
      if (stats.uid !== process.getuid?.()) {
        console.error(
          `Betting profile service token file is not owned by this process: ${tokenFilePath}`,
        );
        return null;
      }
      if ((stats.mode & 0o077) !== 0) {
        console.error(
          `Betting profile service token file is group/world accessible (need 0600): ${tokenFilePath}`,
        );
        return null;
      }
      const raw = await fs.readFile(tokenFilePath, "utf8");
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed;
    } catch {
      console.error(
        `Betting profile service token file unreadable at ${tokenFilePath}`,
      );
      return null;
    }
  }
  const inline = environment[BETTING_PROFILE_TOKEN_ENV]?.trim();
  return inline === undefined || inline === "" ? null : inline;
}
