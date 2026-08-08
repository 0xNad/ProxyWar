import fs from "node:fs/promises";
import path from "node:path";

const [
  manifestPath,
  arm,
  outputPath,
  stepsRaw = "30",
  seedRaw = "424242",
  offManifestOutput,
] = process.argv.slice(2);
if (
  !manifestPath ||
  !outputPath ||
  !["off", "ignored", "active"].includes(arm)
) {
  throw new Error(
    "usage: node make-social-episode-request.mjs <manifest> <off|ignored|active> <output> [steps] [seed] [off-manifest-output]",
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
if (arm === "off") {
  if (!offManifestOutput) {
    throw new Error("off arm requires an explicit off-manifest-output path");
  }
  delete manifest.game?.runnable?.env?.PROXYWAR_TUNE_STRUCTURED_DEALS;
  await fs.mkdir(path.dirname(offManifestOutput), { recursive: true });
  await fs.writeFile(
    offManifestOutput,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
const variant = manifest.variants?.find(
  (candidate) => candidate.id === "tournament-4p-pangaea",
);
const basePlayer = manifest.player?.[0];
if (!variant || !basePlayer) {
  throw new Error("manifest lacks tournament-4p-pangaea or a player runnable");
}
const profiles = ["keeper", "defector", "skeptic", "deal-blind"];
const players = profiles.map((profile) => ({
  type: "player",
  image: `proxywar-social-${profile}-${arm}:local`,
  run: ["node", "/app/social-control-player.mjs"],
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
    purpose: "proxywar-social-control",
    arm,
    roster: profiles.join(","),
    experiment_id: `social-seed-${seed}`,
    seed: String(seed),
    max_decision_steps: String(maxDecisionSteps),
  },
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(request, null, 2)}\n`);
console.log(outputPath);
if (offManifestOutput) console.log(offManifestOutput);
