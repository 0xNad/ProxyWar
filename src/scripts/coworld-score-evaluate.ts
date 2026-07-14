import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  evaluateSavedCoworldEpisodes,
  type SavedCoworldEpisodeScore,
} from "../server/agents/CoworldScoreSemantics";

export interface CoworldScoreEvaluatorOptions {
  inputPath: string;
  seat: number | null;
  policyVersionId: string | null;
}

const usage =
  "Usage: npm run league:evaluate-saved -- <episodes.json> " +
  "[--policy-version-id ID | --seat N]";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asSeat(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function explicitPolicyVersionOrder(
  episode: Record<string, unknown>,
  index: number,
): string[] | null {
  if (!Object.hasOwn(episode, "policy_version_ids")) {
    return null;
  }
  const value = episode.policy_version_ids;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error(`Episode ${index} has invalid policy_version_ids`);
  }
  return value;
}

export function parseCoworldScoreEvaluatorOptions(
  argv: string[],
): CoworldScoreEvaluatorOptions {
  let inputPath: string | null = null;
  let seat: number | null = null;
  let policyVersionId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--seat") {
      seat = asSeat(Number(value));
      if (seat === null) throw new Error("--seat needs a non-negative integer");
      index += 1;
    } else if (argument === "--policy-version-id") {
      if (!value) throw new Error("--policy-version-id needs a value");
      policyVersionId = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (argument.startsWith("-") || inputPath !== null) {
      throw new Error(usage);
    } else {
      inputPath = argument;
    }
  }
  if (inputPath === null) throw new Error(usage);
  if (seat !== null && policyVersionId !== null) {
    throw new Error("--seat and --policy-version-id are mutually exclusive");
  }
  return { inputPath, seat, policyVersionId };
}

function parseScores(
  raw: unknown,
  policyVersionOrder: readonly string[] | null,
  index: number,
): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Episode ${index} has no scores array`);
  }
  if (policyVersionOrder !== null && policyVersionOrder.length !== raw.length) {
    throw new Error(`Episode ${index} has score/order cardinality mismatch`);
  }
  if (
    raw.every((score) => typeof score === "number" && Number.isFinite(score))
  ) {
    return raw as number[];
  }
  const pairs = raw.map((entry) => {
    const record = asRecord(entry);
    const policyVersionId = record?.policy_version_id;
    const score = record?.score;
    if (
      typeof policyVersionId !== "string" ||
      typeof score !== "number" ||
      !Number.isFinite(score)
    ) {
      throw new Error(`Episode ${index} has an invalid score entry`);
    }
    return { policyVersionId, score };
  });
  if (policyVersionOrder !== null) {
    const byPolicy = new Map<string, number[]>();
    for (const pair of pairs) {
      const scores = byPolicy.get(pair.policyVersionId) ?? [];
      scores.push(pair.score);
      byPolicy.set(pair.policyVersionId, scores);
    }
    return policyVersionOrder.map((policyVersionId) => {
      const scores = byPolicy.get(policyVersionId);
      const score = scores?.shift();
      if (score === undefined) {
        throw new Error(`Episode ${index} is missing a policy score`);
      }
      return score;
    });
  }
  return pairs.map((pair) => pair.score);
}

function oneHotWinnerSlot(scores: readonly number[]): number | null {
  const winners = scores.flatMap((score, slot) => (score === 1 ? [slot] : []));
  return winners.length === 1 &&
    scores.every((score) => score === 0 || score === 1)
    ? winners[0]
    : null;
}

function parseEpisode(
  value: unknown,
  index: number,
  options: CoworldScoreEvaluatorOptions,
): SavedCoworldEpisodeScore[] {
  const episode = asRecord(value);
  if (episode === null) throw new Error(`Episode ${index} is not an object`);
  const results = asRecord(episode.results) ?? episode;
  const policyVersionOrder = explicitPolicyVersionOrder(episode, index);
  const scores = parseScores(results.scores, policyVersionOrder, index);
  const embeddedSeat =
    asSeat(episode.seat) ??
    asSeat(episode.target_slot) ??
    asSeat(episode.policy_slot);
  const seats =
    options.seat !== null
      ? [options.seat]
      : options.policyVersionId !== null
        ? (policyVersionOrder ?? []).flatMap((policyVersionId, seat) =>
            policyVersionId === options.policyVersionId ? [seat] : [],
          )
        : embeddedSeat === null
          ? []
          : [embeddedSeat];
  if (seats.length === 0 || seats.some((seat) => scores[seat] === undefined)) {
    throw new Error(`Episode ${index} has no matching target seat`);
  }
  const winnerSlotPresent = Object.hasOwn(results, "winner_slot");
  const outrightWinnerSlot = winnerSlotPresent
    ? results.winner_slot === null
      ? null
      : asSeat(results.winner_slot)
    : oneHotWinnerSlot(scores);
  if (
    winnerSlotPresent &&
    results.winner_slot !== null &&
    (outrightWinnerSlot === null || outrightWinnerSlot >= scores.length)
  ) {
    throw new Error(`Episode ${index} has an invalid winner_slot`);
  }
  const gameConfig =
    asRecord(episode.game_config) ?? asRecord(episode.gameConfig);
  const map =
    (typeof episode.map === "string" ? episode.map : null) ??
    (typeof gameConfig?.map === "string" ? gameConfig.map : null) ??
    "Unknown map";
  return seats.map((seat) => ({ map, seat, scores, outrightWinnerSlot }));
}

export function parseSavedCoworldScoreEpisodes(
  saved: unknown,
  options: CoworldScoreEvaluatorOptions,
): SavedCoworldEpisodeScore[] {
  const root = asRecord(saved);
  const entries = Array.isArray(saved)
    ? saved
    : Array.isArray(root?.episodes)
      ? root.episodes
      : [];
  if (entries.length === 0) throw new Error("Input has no episodes");
  return entries.flatMap((entry, index) => parseEpisode(entry, index, options));
}

async function main(): Promise<void> {
  const options = parseCoworldScoreEvaluatorOptions(process.argv.slice(2));
  const saved = JSON.parse(
    await fs.readFile(options.inputPath, "utf8"),
  ) as unknown;
  const episodes = parseSavedCoworldScoreEpisodes(saved, options);
  console.log(JSON.stringify(evaluateSavedCoworldEpisodes(episodes), null, 2));
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
