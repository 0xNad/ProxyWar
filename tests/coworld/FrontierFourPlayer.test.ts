/**
 * The Frontier player (v2) behind Softmax's LLM sidecar: how it calls the
 * model. These tests drive it over a fake socket against an in-process
 * sidecar stand-in and check the fairness rules of Season 2: every model
 * gets the same request, plans land at the same fixed checkpoints with a hard
 * call cap, the seat waits for its plan (up to a timeout) instead of planning
 * in the background, a refused control is dropped once and logged, and a
 * spend cutoff stops the planner while the seat keeps answering legally.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureStdout,
  decide,
  ffaActions,
  ffaObservation,
  gameOf,
  IDS,
  loadPlayer,
  signalListenerGuard,
  startStubSidecar,
} from "./FrontierPlayerHarness";

const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(
      path.resolve("coworld-adapter/frontier-four/package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

const SLUGS = [
  "openai/gpt-6-astra",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-5.5",
  "google/gemini-3.1-pro-preview",
  "x-ai/grok-4.7",
];

describe("Frontier player: model calls", () => {
  const sidecars: Server[] = [];
  let stdout: ReturnType<typeof captureStdout>;
  let releaseSignals: () => void;
  afterEach(async () => {
    for (const server of sidecars.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
    stdout?.restore();
    releaseSignals?.();
  });
  const begin = () => {
    stdout = captureStdout();
    releaseSignals = signalListenerGuard();
  };

  it("sends every model the same request: one wire format, one token limit, one reasoning setting", async () => {
    begin();
    const bodies: Array<Record<string, unknown>> = [];
    for (const model of SLUGS) {
      const sidecar = await startStubSidecar();
      sidecars.push(sidecar.server);
      const socket = await loadPlayer({
        COWORLD_LLM_ENDPOINT: sidecar.url,
        COWORLD_LLM_MODEL: model,
      });
      await decide(socket, ffaObservation(), ffaActions());
      expect(sidecar.calls).toHaveLength(1);
      expect(sidecar.calls[0].path).toBe("/v1/chat/completions");
      bodies.push(sidecar.calls[0].body);
    }
    for (const [index, body] of bodies.entries()) {
      expect(body.model).toBe(SLUGS[index]);
      expect(Object.keys(body).sort()).toEqual([
        "max_tokens",
        "messages",
        "model",
        "reasoning",
      ]);
      expect(body.max_tokens).toBe(3000);
      expect(body.reasoning).toEqual({ effort: "low" });
      // Apart from the slug, the requests are byte-identical.
      expect({ ...body, model: "x" }).toEqual({ ...bodies[0], model: "x" });
    }
    const messages = bodies[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("SECURITY");
    expect(messages[0].content).not.toContain("TEAM GAME");
    // The params sent are on record in the usage line.
    const response = stdout
      .tagged("PROXYWAR_LLM_USAGE")
      .find((event) => event.event === "response");
    expect(response).toMatchObject({
      // harness.playerVersion is the package's semver (contract B).
      playerVersion: PACKAGE_VERSION,
      promptVariant: "frontier-v2",
      maxOutputTokens: 3000,
      reasoning: "low",
      checkpoint: 1,
      decisionStep: 1,
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 90,
      cacheReadTokens: 400,
    });
  });

  it("plans synchronously at fixed checkpoints and stops at the call cap", async () => {
    begin();
    const sidecar = await startStubSidecar({ latencyMs: () => 80 });
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "x-ai/grok-4.7",
      PLAN_EVERY: "3",
      MAX_PLANS: "3",
    });
    const responses = [];
    const elapsed = [];
    for (let step = 1; step <= 10; step++) {
      const started = Date.now();
      responses.push(await decide(socket, ffaObservation(), ffaActions()));
      elapsed.push(Date.now() - started);
    }
    // Checkpoints at step 1 and every third step, until three plans exist.
    expect(sidecar.calls).toHaveLength(3);
    const plans = stdout.tagged("PROXYWAR_PLAN");
    expect(plans.map((p) => [p.checkpoint, p.decisionStep, p.status])).toEqual([
      [1, 1, "applied"],
      [2, 3, "applied"],
      [3, 6, "applied"],
    ]);
    // The seat waited for its plan: the very first answer already follows it
    // (attack the named target), and checkpoint steps took the model's time.
    expect(responses[0].selectedLegalActionId).toBe(`attack:${IDS.grok}:40`);
    expect(responses[0].llmPlannerDegraded).toBe(false);
    for (const index of [0, 2, 5]) expect(elapsed[index]).toBeGreaterThan(60);
    expect(elapsed[8]).toBeLessThan(60); // step 9: past the cap, no call
    socket.emit("message", JSON.stringify({ type: "final", slot: 0 }));
    const summary = stdout
      .tagged("PROXYWAR_LLM_USAGE")
      .find((event) => event.event === "summary");
    expect(summary).toMatchObject({
      plans: 3,
      planFailures: 0,
      checkpoints: 3,
      attempts: 3,
      responses: 3,
      reasoningTokens: 270,
    });
  });

  it("drops a control the route refuses, once, logs it, and keeps the rest of the request", async () => {
    begin();
    const sidecar = await startStubSidecar({ rejectReasoning: true });
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "anthropic/claude-opus-5.5",
      PLAN_EVERY: "1",
      MAX_PLANS: "2",
    });
    await decide(socket, ffaObservation(), ffaActions());
    await decide(socket, ffaObservation(), ffaActions());
    expect(sidecar.calls.map((call) => "reasoning" in call.body)).toEqual([
      true,
      false,
      false,
    ]);
    expect(sidecar.calls[1].body.max_tokens).toBe(3000);
    const drops = stdout
      .tagged("PROXYWAR_LLM_USAGE")
      .filter((event) => event.event === "control_dropped");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      control: "reasoning",
      status: "routing_parameters",
    });
    expect(
      stdout
        .tagged("PROXYWAR_LLM_USAGE")
        .filter((event) => event.event === "response")
        .map((event) => event.reasoning),
    ).toEqual(["dropped", "dropped"]);
    expect(stdout.tagged("PROXYWAR_PLAN").map((plan) => plan.status)).toEqual([
      "applied",
      "applied",
    ]);
  });

  it("keeps reasoning when a refusal persists without it: an unrelated 400 never changes later requests", async () => {
    begin();
    // The first request and its retry without reasoning are both refused,
    // so reasoning was not the cause.
    const sidecar = await startStubSidecar({
      refuse: (request) =>
        request <= 2 ? { status: 400, category: "invalid_request" } : null,
    });
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "anthropic/claude-fable-5.1",
      PLAN_EVERY: "1",
      MAX_PLANS: "4",
    });
    for (let step = 0; step < 4; step++)
      await decide(socket, ffaObservation(), ffaActions());
    expect(sidecar.calls.map((call) => "reasoning" in call.body)).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
    const usage = stdout.tagged("PROXYWAR_LLM_USAGE");
    expect(usage.filter((e) => e.event === "control_dropped")).toEqual([]);
    expect(
      usage.filter((e) => e.event === "response").map((e) => e.reasoning),
    ).toEqual(["low", "low", "low"]);
    expect(stdout.tagged("PROXYWAR_PLAN").map((plan) => plan.status)).toEqual([
      "failed",
      "applied",
      "applied",
      "applied",
    ]);
  });

  it("keeps the previous plan when a checkpoint times out, and says so", async () => {
    begin();
    const sidecar = await startStubSidecar({
      latencyMs: (call) => (call === 1 ? 5 : 2000),
    });
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "google/gemini-3.1-pro-preview",
      PLAN_EVERY: "2",
      PLAN_TIMEOUT_MS: "300",
    });
    await decide(socket, ffaObservation(), ffaActions());
    const started = Date.now();
    const late = await decide(socket, ffaObservation(), ffaActions());
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(1500);
    // Still the first plan's move, flagged as a timeout.
    expect(late.selectedLegalActionId).toBe(`attack:${IDS.grok}:40`);
    expect(late.degradedCause).toBe("plan-timeout");
    expect(late.llmPlannerDegraded).toBe(true);
    expect(stdout.tagged("PROXYWAR_PLAN").map((p) => p.status)).toEqual([
      "applied",
      "timeout",
    ]);
    // The next decision does not call again: no background refresh.
    await decide(socket, ffaObservation(), ffaActions());
    expect(sidecar.calls).toHaveLength(2);
  });

  it("stops planning after a spend cutoff and keeps playing, loudly degraded", async () => {
    begin();
    const sidecar = await startStubSidecar({ spendLimit: true });
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "x-ai/grok-4.7",
      PLAN_EVERY: "1",
      MAX_PLANS: "4",
    });
    const actions = ffaActions();
    const legal = new Set(actions.map((action) => action.id));
    const responses = [];
    for (let step = 0; step < 4; step++)
      responses.push(await decide(socket, ffaObservation(), actions));
    expect(responses.every((r) => legal.has(r.selectedLegalActionId))).toBe(
      true,
    );
    // One request reached the sidecar; after the 429 the planner never asks again.
    expect(sidecar.calls).toHaveLength(1);
    const last = responses[3];
    expect(last.llmPlannerDegraded).toBe(true);
    expect(last.fallbackUsed).toBe(true);
    expect(String(last.reason)).toContain("spend limit");
    expect(
      stdout
        .tagged("PROXYWAR_PLAN")
        .map((plan) => [plan.status, plan.error ?? null]),
    ).toEqual([
      ["failed", "spend_limit"],
      ["failed", "spend_limit"],
      ["failed", "spend_limit"],
      ["failed", "spend_limit"],
    ]);
  });

  it("gives the model a small prompt: four rivals, a per-kind menu summary, rival ids and spatial facts", async () => {
    begin();
    const sidecar = await startStubSidecar();
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "openai/gpt-6-astra",
    });
    const observation = ffaObservation();
    const players = observation.visiblePlayers as Array<
      Record<string, unknown>
    >;
    // Seven more rivals than the prompt shows in full.
    for (let i = 0; i < 7; i++)
      players.push({
        ...players[3],
        playerID: `extra${i}`,
        name: `Extra ${i}`,
        tileShare: 0.01,
      });
    await decide(socket, observation, ffaActions());
    const game = gameOf(sidecar.calls[0]);
    const rivals = game.rivals as Array<Record<string, unknown>>;
    expect(rivals).toHaveLength(4);
    expect(rivals.map((r) => r.name)).toContain("Gemini 1");
    expect((game.otherRivals as unknown[]).length).toBe(7);
    // Rival ids and the spatial block reach the model (schema 5 is accepted).
    const fable = rivals.find((r) => r.name === "Fable 1");
    expect(fable).toMatchObject({
      playerID: IDS.fable,
      bearing: "east",
      distance: "adjacent",
      border: { tiles: 40, shareOfYourBorder: 35, defensePosts: 1 },
      asksYouToAlly: true,
    });
    expect(game.spatial).toMatchObject({ quadrant: "west", coastShare: 22 });
    // The menu is summarised per kind, not listed id by id.
    expect(game.legalActions).toBeUndefined();
    expect(game.options).toMatchObject({
      attackByLand: ["Fable 1", "Grok 1"],
      expandNeutral: true,
      boatTo: ["Opus 1"],
      allianceRequest: ["Fable 1"],
      breakAlliance: ["Gemini 1"],
    });
    expect(JSON.stringify(game)).not.toContain("quick_chat");
    const user = (
      sidecar.calls[0].body.messages as Array<{ content: string }>
    )[1].content;
    expect(user.length).toBeLessThan(4000);
    const usage = stdout
      .tagged("PROXYWAR_LLM_USAGE")
      .find((event) => event.event === "response");
    expect(usage?.spatialSchemaVersion).toBe(5);
  });

  it("drops the spatial block when the server sends none, but keeps rival ids", async () => {
    begin();
    const sidecar = await startStubSidecar();
    sidecars.push(sidecar.server);
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: sidecar.url,
      COWORLD_LLM_MODEL: "openai/gpt-6-astra",
    });
    await decide(socket, ffaObservation({ spatial: undefined }), ffaActions());
    const game = gameOf(sidecar.calls[0]);
    expect(game.spatial).toBeUndefined();
    const fable = (game.rivals as Array<Record<string, unknown>>).find(
      (r) => r.name === "Fable 1",
    );
    expect(fable?.playerID).toBe(IDS.fable);
    expect(fable?.bearing).toBeUndefined();
  });
});
