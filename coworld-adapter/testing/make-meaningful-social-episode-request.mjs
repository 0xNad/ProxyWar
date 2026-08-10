import fs from "node:fs/promises";
import path from "node:path";

const [
  manifestPath,
  outputPath,
  stepsRaw = "80",
  seedRaw = "173205",
] = process.argv.slice(2);
if (!manifestPath || !outputPath) {
  throw new Error(
    "usage: node make-meaningful-social-episode-request.mjs <manifest> <output> [steps] [seed]",
  );
}
const maxDecisionSteps = Number(stepsRaw);
const seed = Number(seedRaw);
if (!Number.isSafeInteger(maxDecisionSteps) || maxDecisionSteps < 1) {
  throw new Error("steps must be a positive safe integer");
}
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 11881375) {
  throw new Error("seed must be an integer from 0 through 11881375");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const variant = manifest.variants?.find(
  (candidate) => candidate.id === "tournament-4p-pangaea",
);
if (!variant) {
  throw new Error("manifest lacks tournament-4p-pangaea");
}
const profiles = ["pact-keeper", "pact-breaker", "mutual-aid", "deal-blind"];
const players = profiles.map((profile) => ({
  type: "player",
  image: `proxywar-social-${profile}:meaningful-local`,
  run: ["node", "/app/hosted-social-counterparty-player.mjs"],
  env: {},
}));
const request = {
  manifest,
  game_config: {
    ...variant.game_config,
    max_decision_steps: maxDecisionSteps,
    episodeIndex: 0,
    seed,
  },
  players,
  episode_tags: {
    purpose: "proxywar-meaningful-social-control",
    roster: profiles.join(","),
    experiment_id: `meaningful-social-seed-${seed}`,
    seed: String(seed),
    max_decision_steps: String(maxDecisionSteps),
  },
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(request, null, 2)}\n`);
console.log(outputPath);
