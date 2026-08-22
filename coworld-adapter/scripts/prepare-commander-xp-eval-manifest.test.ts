import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The executable MJS helper intentionally has no emitted TS declarations.
import { commanderXpEvalManifest } from "./prepare-commander-xp-eval-manifest.mjs";

const base = JSON.parse(
  fs.readFileSync(
    path.resolve(
      process.cwd(),
      "coworld-adapter/coworld/coworld_manifest.json",
    ),
    "utf8",
  ),
);

describe("Commander XP eval-only Coworld manifest", () => {
  it("uses a distinct namespace, exact evidence env, and terminal cadence", () => {
    const manifest = commanderXpEvalManifest(base, {
      image: `proxywar-coworld-commander-xp-eval@sha256:${"a".repeat(64)}`,
      version: "0.0.1",
    });
    expect(manifest.game.name).toBe("proxywar-commander-xp-eval");
    expect(manifest.game.name).not.toBe(base.game.name);
    expect(manifest.game.runnable.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(manifest.commissioner).toEqual([]);
    expect(manifest.player).toHaveLength(1);
    expect(manifest.player[0]).toMatchObject({
      id: "proxywar-starter-websocket",
      type: "player",
      image: `proxywar-coworld-commander-xp-eval@sha256:${"a".repeat(64)}`,
      run: ["node", "/app/integration/src/starter-player.mjs"],
      env: {},
    });
    expect(manifest.variants.map((entry: { id: string }) => entry.id)).toEqual([
      "tournament-4p-pangaea",
    ]);
    expect(manifest.tags).toEqual(["evaluation"]);
    expect(JSON.stringify(manifest)).not.toContain(
      "COWORLD_PLAYER_ARTIFACT_UPLOAD_URL",
    );
    expect(manifest.game.config_schema.required).toContain(
      "commander_xp_phase",
    );
    expect(manifest.game.config_schema.properties.commander_xp_phase).toEqual({
      type: "string",
      enum: ["provider-preflight", "canary", "confirmatory"],
    });
    expect(manifest.game.runnable.env).toEqual({
      PROXYWAR_COMMANDER_XP_GAME_EVIDENCE: "1",
      PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
      PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
      PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
    });
    const variant = manifest.variants.find(
      (entry: { id: string }) => entry.id === "tournament-4p-pangaea",
    );
    expect(variant.game_config).toMatchObject({
      max_decision_steps: 360,
      turns_per_decision_step: 100,
      max_decision_ms: 15_000,
      episode_timeout_seconds: 6_000,
      seed: 17,
      commander_xp_phase: "canary",
    });
    expect(manifest.certification.game_config.commander_xp_phase).toBe(
      "provider-preflight",
    );
  });

  it("rejects mutable images", () => {
    expect(() =>
      commanderXpEvalManifest(base, {
        image: "proxywar-coworld-commander-xp-eval:latest",
        version: "0.0.1",
      }),
    ).toThrow("immutable digest");
  });
});
