/**
 * Pulls the CURRENT ACTIVE league roster — every active champion policy, no
 * sampling — so a premiere-wagering pre-simulation seats the whole league,
 * not a subset (operator directive: "pull the current roster and seat every
 * active policy").
 *
 * Read-only toward Softmax: only the same read verbs
 * `coworld-league-mirror.ts` already uses (`leagues`, `results`,
 * `memberships`), same `uvx coworld ... --json` invocation. This module
 * never mutates hosted state — that happens in
 * `generate-xp-request-episode.ts`, which consumes this roster.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseLeagueSummary,
  pickCompetitionDivision,
} from "../../server/agents/CoworldLeagueMirrorCore";

const execFileAsync = promisify(execFile);

export interface ActiveRosterSeat {
  readonly policyVersionId: string;
  readonly policyLabel: string;
  readonly playerId: string;
  readonly playerName: string | null;
}

export interface ActiveLeagueRoster {
  readonly leagueId: string;
  readonly divisionId: string;
  readonly divisionName: string;
  readonly seats: readonly ActiveRosterSeat[];
}

export class PremiereWageringRosterError extends Error {}

export type CoworldJsonInvoker = (args: string[]) => Promise<unknown>;

const READ_VERBS = new Set(["leagues", "results", "memberships"]);

/** Same read-only `uvx coworld <verb> ... --json` pattern as
 * `coworld-league-mirror.ts`'s `coworldJson` — duplicated rather than
 * imported because that function is module-private there. */
export const defaultCoworldJsonInvoker: CoworldJsonInvoker = async (args) => {
  const verb = args[0];
  if (!READ_VERBS.has(verb)) {
    throw new PremiereWageringRosterError(
      `refusing non-read coworld verb: ${verb}`,
    );
  }
  const { stdout } = await execFileAsync(
    "uvx",
    ["coworld", ...args, "--json"],
    { timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Membership `substatus` values actually observed on this league (verified
 * live against `coworld memberships --json` and against
 * `coworld-adapter/commissioner/commissioners/common/models.py`'s
 * `POLICY_MEMBERSHIP_SUBSTATUS_*` constants + the qualifier stage's
 * `on_round_complete` action in `proxywar.yaml`, which sets
 * `substatus: champion` the moment a policy is promoted into Competition):
 * `"active"` and `"champion"` BOTH mean "currently a real, competing
 * champion" — `"champion"` is not a demotion or a terminal state, it is the
 * substatus a policy is given the moment it becomes (or currently is) the
 * reigning champion. A membership with `is_champion:true` legitimately
 * carries either label depending on which commissioner pass last touched
 * it. Treating `"champion"` as "not active" (the prior bug) silently
 * dropped whichever policy happened to hold that substatus at pull time —
 * observed live on djizus, and reproducibly on richard / James Boggs.
 * `"benched"` / `"inactive"` / `"crash"` are genuinely NOT current
 * champions (benched is set exactly when `is_champion` is false; inactive
 * marks disqualification; crash marks a broken policy container) and stay
 * excluded.
 */
const RUNNABLE_CHAMPION_SUBSTATUSES = new Set(["active", "champion"]);

/**
 * Every DISTINCT active, competing, champion policy in the division —
 * de-duplicated by `policyVersionId` (a policy can hold more than one
 * membership row, e.g. across nested rating carry-over) so the roster never
 * seats the same policy twice under two labels.
 */
function parseActiveRosterSeats(value: unknown): ActiveRosterSeat[] {
  const seatByPolicyVersionId = new Map<string, ActiveRosterSeat>();
  for (const entry of Array.isArray(value) ? value : []) {
    const membership = isRecord(entry) ? entry : null;
    const substatus = membership !== null ? asString(membership.substatus) : null;
    if (
      membership === null ||
      membership.status !== "competing" ||
      (substatus !== null && !RUNNABLE_CHAMPION_SUBSTATUSES.has(substatus)) ||
      membership.is_champion !== true ||
      asString(membership.end_time) !== null
    ) {
      continue;
    }
    const policyVersion = isRecord(membership.policy_version)
      ? membership.policy_version
      : null;
    const player = isRecord(membership.player) ? membership.player : null;
    const policyVersionId = policyVersion !== null ? asString(policyVersion.id) : null;
    const policyLabel = policyVersion !== null ? asString(policyVersion.label) : null;
    const playerId =
      (policyVersion !== null ? asString(policyVersion.player_id) : null) ??
      (player !== null ? asString(player.id) : null);
    if (policyVersionId === null || policyLabel === null || playerId === null) {
      continue;
    }
    if (!seatByPolicyVersionId.has(policyVersionId)) {
      seatByPolicyVersionId.set(policyVersionId, {
        policyVersionId,
        policyLabel,
        playerId,
        playerName: player !== null ? asString(player.name) : null,
      });
    }
  }
  return [...seatByPolicyVersionId.values()].sort((a, b) =>
    a.policyVersionId.localeCompare(b.policyVersionId),
  );
}

/**
 * Explains, for a `standings[]` player who has no resolved seat, what their
 * most recent membership row in this division actually says — so a
 * reconciliation failure names a reason instead of just a player.
 */
function diagnoseMissingSeat(playerId: string, membershipsRaw: unknown): string {
  let best: {
    status: unknown;
    substatus: string | null;
    isChampion: unknown;
    endTime: string | null;
    startedAt: number;
  } | null = null;
  for (const entry of Array.isArray(membershipsRaw) ? membershipsRaw : []) {
    const membership = isRecord(entry) ? entry : null;
    if (membership === null) {
      continue;
    }
    const policyVersion = isRecord(membership.policy_version)
      ? membership.policy_version
      : null;
    const player = isRecord(membership.player) ? membership.player : null;
    const membershipPlayerId =
      (policyVersion !== null ? asString(policyVersion.player_id) : null) ??
      (player !== null ? asString(player.id) : null);
    if (membershipPlayerId !== playerId) {
      continue;
    }
    const parsedStartedAt = Date.parse(asString(membership.start_time) ?? "");
    const startedAt = Number.isFinite(parsedStartedAt)
      ? parsedStartedAt
      : Number.NEGATIVE_INFINITY;
    if (best === null || startedAt > best.startedAt) {
      best = {
        status: membership.status,
        substatus: asString(membership.substatus),
        isChampion: membership.is_champion,
        endTime: asString(membership.end_time),
        startedAt,
      };
    }
  }
  if (best === null) {
    return "no membership record found in this division";
  }
  return (
    `status=${JSON.stringify(best.status)} substatus=${JSON.stringify(best.substatus)} ` +
    `is_champion=${JSON.stringify(best.isChampion)} end_time=${JSON.stringify(best.endTime)}`
  );
}

/**
 * The league's own `standings[]` (division `results`) is the authoritative
 * "who is in this league" list — the same source the public league mirror
 * (`CoworldLeagueMirrorCore.ts`'s `buildStandingRows`) renders. Every
 * standings player MUST resolve to a runnable seat here; a standings player
 * with no seat is exactly the class of bug that silently produced
 * `policyLabel: null` rows on the public standings page. Fail loudly, by
 * name and reason, instead of quietly seating fewer players than the league
 * actually has.
 */
export function assertRosterReconcilesWithStandings(
  standingsRaw: unknown,
  membershipsRaw: unknown,
  seats: readonly ActiveRosterSeat[],
): void {
  const seatPlayerIds = new Set(seats.map((seat) => seat.playerId));
  const seenPlayerIds = new Set<string>();
  const mismatches: string[] = [];
  for (const entry of Array.isArray(standingsRaw) ? standingsRaw : []) {
    const row = isRecord(entry) ? entry : null;
    const playerId = row !== null ? asString(row.player_id) : null;
    if (playerId === null || seenPlayerIds.has(playerId) || seatPlayerIds.has(playerId)) {
      continue;
    }
    seenPlayerIds.add(playerId);
    const playerName = row !== null ? (asString(row.player_name) ?? playerId) : playerId;
    mismatches.push(`${playerName} (${playerId}): ${diagnoseMissingSeat(playerId, membershipsRaw)}`);
  }
  if (mismatches.length > 0) {
    throw new PremiereWageringRosterError(
      `roster does not reconcile with league standings — ${mismatches.length} standings ` +
        `player(s) did not resolve to a runnable policy: ${mismatches.join("; ")}`,
    );
  }
}

/**
 * Resolves the league's competition division and returns every active
 * champion policy in it. Throws (never silently returns a partial roster) if
 * the league or division can't be resolved — an xp-request seating a
 * truncated roster is a product bug, not a degraded-but-fine cycle the way a
 * stale mirror sync is.
 */
export async function fetchActiveLeagueRoster(options: {
  readonly leagueId: string;
  readonly coworldJson?: CoworldJsonInvoker;
}): Promise<ActiveLeagueRoster> {
  const coworldJson = options.coworldJson ?? defaultCoworldJsonInvoker;
  const [leagueRaw, divisionsRaw] = await Promise.all([
    coworldJson(["leagues", options.leagueId]),
    coworldJson(["results", options.leagueId]),
  ]);
  const league = parseLeagueSummary(leagueRaw);
  if (league === null) {
    throw new PremiereWageringRosterError(
      `league ${options.leagueId} not found or unreadable`,
    );
  }
  const division = pickCompetitionDivision(divisionsRaw);
  if (division === null) {
    throw new PremiereWageringRosterError(
      `league ${options.leagueId} has no readable competition division`,
    );
  }
  // No `--active-only --champions-only`: those hosted filters gate on
  // `status`/`is_champion`, which `parseActiveRosterSeats` already re-checks
  // client-side, and fetching the full division roster here means
  // `assertRosterReconcilesWithStandings` can explain the *reason* a
  // standings player is missing (disqualified, crashed, ...) rather than
  // just observing their absence.
  const [membershipsRaw, standingsRaw] = await Promise.all([
    coworldJson(["memberships", "-d", division.id, "--limit", "1000"]),
    coworldJson(["results", division.id]),
  ]);
  const seats = parseActiveRosterSeats(membershipsRaw);
  assertRosterReconcilesWithStandings(standingsRaw, membershipsRaw, seats);
  if (seats.length === 0) {
    throw new PremiereWageringRosterError(
      `division ${division.id} has zero active champion policies — nothing to seat`,
    );
  }
  return {
    leagueId: league.id,
    divisionId: division.id,
    divisionName: division.name,
    seats,
  };
}
