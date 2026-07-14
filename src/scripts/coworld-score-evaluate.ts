import { promises as fs } from "node:fs";
import {
  evaluateSavedCoworldEpisodes,
  type SavedCoworldEpisodeScore,
} from "../server/agents/CoworldScoreSemantics";

interface Options {
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

function asStrings(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
    ? value
    : [];
}

function parseOptions(argv: string[]): Options {
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
  return { inputPath, seat, policyVersionId };
}

function parseScores(
  raw: unknown,
  episode: Record<string, unknown>,
  index: number,
): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Episode ${index} has no scores array`);
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
  const seatOrder = asStrings(episode.policy_version_ids);
  if (seatOrder.length === pairs.length) {
    const byPolicy = new Map(
      pairs.map((pair) => [pair.policyVersionId, pair.score]),
    );
    return seatOrder.map((policyVersionId) => {
      const score = byPolicy.get(policyVersionId);
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
  options: Options,
): SavedCoworldEpisodeScore {
  const episode = asRecord(value);
  if (episode === null) throw new Error(`Episode ${index} is not an object`);
  const results = asRecord(episode.results) ?? episode;
  const scores = parseScores(results.scores, episode, index);
  const policySeat =
    options.policyVersionId === null
      ? null
      : asSeat(
          asStrings(episode.policy_version_ids).indexOf(
            options.policyVersionId,
          ),
        );
  const seat =
    asSeat(episode.seat) ??
    asSeat(episode.target_slot) ??
    asSeat(episode.policy_slot) ??
    policySeat ??
    options.seat;
  if (seat === null || scores[seat] === undefined) {
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
    outrightWinnerSlot === null
  ) {
    throw new Error(`Episode ${index} has an invalid winner_slot`);
  }
  const gameConfig =
    asRecord(episode.game_config) ?? asRecord(episode.gameConfig);
  const map =
    (typeof episode.map === "string" ? episode.map : null) ??
    (typeof gameConfig?.map === "string" ? gameConfig.map : null) ??
    "Unknown map";
  return { map, seat, scores, outrightWinnerSlot };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const saved = JSON.parse(
    await fs.readFile(options.inputPath, "utf8"),
  ) as unknown;
  const root = asRecord(saved);
  const entries = Array.isArray(saved)
    ? saved
    : Array.isArray(root?.episodes)
      ? root.episodes
      : [];
  if (entries.length === 0) throw new Error("Input has no episodes");
  const episodes = entries.map((entry, index) =>
    parseEpisode(entry, index, options),
  );
  console.log(JSON.stringify(evaluateSavedCoworldEpisodes(episodes), null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
