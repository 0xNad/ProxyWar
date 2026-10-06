/**
 * The Frontier player against the repository's mock sidecar
 * (coworld-adapter/frontier-four/mock-llm-server.mjs), the same stand-in a
 * local no-Docker game uses. Over thirty steps the mock's varied v2 plans must
 * reach every contract-A line, name only rivals the player showed, and never
 * make the seat send filler or a diplomacy id as its map move.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureStdout,
  decide,
  ffaActions,
  ffaObservation,
  type Json,
  loadPlayer,
  MOCK_SIDECAR,
  signalListenerGuard,
} from "./FrontierPlayerHarness";

describe("Frontier player against the mock sidecar", () => {
  let server: Server | null = null;
  let stdout: ReturnType<typeof captureStdout>;
  let releaseSignals: () => void;
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    stdout?.restore();
    releaseSignals?.();
  });

  it("plays thirty steps on varied plans with every contract-A line and no filler", async () => {
    stdout = captureStdout();
    releaseSignals = signalListenerGuard();
    const mock = (await import(pathToFileURL(MOCK_SIDECAR).href)) as {
      createMockLlmServer: (options: {
        log: (line: string) => void;
        latencyMs: [number, number];
      }) => Server;
    };
    const mockLog: string[] = [];
    server = mock.createMockLlmServer({
      log: (line) => mockLog.push(line),
      latencyMs: [5, 20],
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    const socket = await loadPlayer({
      COWORLD_LLM_ENDPOINT: `http://127.0.0.1:${port}`,
      COWORLD_LLM_MODEL: "x-ai/grok-4.7",
      PLAN_EVERY: "5",
      MAX_PLANS: "7",
    });
    const menu = [
      ...ffaActions(),
      {
        id: "build:Atom Bomb:555",
        kind: "nuke",
        label: "nuke",
        risk: { level: "high" },
        metadata: {
          unit: "Atom Bomb",
          targetID: "r5o3pta1",
          cost: "750000",
        },
      },
    ];
    // Every id the seat may send must come from the menu it was sent.
    const kinds = new Map(menu.map((a) => [String(a.id), String(a.kind)]));
    const responses: Json[] = [];
    for (let step = 1; step <= 31; step++) {
      const observation = ffaObservation();
      // From the third plan on the seat owns a silo, so planned nukes fire.
      if (step >= 10)
        (observation.ownState as Json).unitCounts = {
          City: 3,
          "Missile Silo": 1,
        };
      responses.push(await decide(socket, observation, menu));
    }
    socket.emit("message", JSON.stringify({ type: "final", slot: 0 }));

    // Checkpoints at steps 1, 5, 10, 15, 20, 25, 30: seven plans, all applied.
    const plans = stdout.tagged("PROXYWAR_PLAN");
    expect(plans.map((p) => p.decisionStep)).toEqual([
      1, 5, 10, 15, 20, 25, 30,
    ]);
    expect(plans.every((p) => p.status === "applied")).toBe(true);
    expect(mockLog).toHaveLength(7);
    // The plans vary and only name rivals the player showed the model.
    const rivals = ["Fable 1", "Gemini 1", "Grok 1", "Opus 1"];
    expect(new Set(plans.map((p) => p.focus)).size).toBeGreaterThan(2);
    for (const plan of plans) {
      for (const name of [plan.target, plan.nuke, plan.betray].filter(Boolean))
        expect(rivals).toContain(name);
    }
    expect(stdout.tagged("PROXYWAR_DISPATCH").length).toBe(7);
    const says = stdout.tagged("PROXYWAR_SAY");
    expect(says.some((say) => say.accepted === true)).toBe(true);
    for (const say of says.filter((s) => s.accepted === true))
      expect(rivals).toContain(say.to);
    const usage = stdout.tagged("PROXYWAR_LLM_USAGE");
    expect(usage.find((e) => e.event === "summary")).toMatchObject({
      plans: 7,
      planFailures: 0,
      checkpoints: 7,
    });
    // Every answer: offered ids only, and a map move that is never filler or
    // diplomacy (the Season 1 "unknown action id" holds came from diplomacy
    // ids in the primary slot).
    const mapKinds = ["attack", "boat", "build", "upgrade_structure", "nuke"];
    for (const response of responses) {
      const primary = String(response.selectedLegalActionId);
      expect(kinds.has(primary)).toBe(true);
      expect(mapKinds).toContain(kinds.get(primary));
      const batch = (response.selectedLegalActionIds as string[]) ?? [];
      if (batch.length > 0) {
        expect(batch[0]).toBe(primary);
        expect(batch.length).toBeLessThanOrEqual(2);
      }
      for (const id of batch) expect(kinds.has(id)).toBe(true);
      for (const id of batch.slice(1))
        expect([
          "alliance_request",
          "alliance_extend",
          "break_alliance",
          "donate_troops",
          "donate_gold",
        ]).toContain(kinds.get(id));
      if (response.selectedMessageActionId !== undefined)
        expect(kinds.get(String(response.selectedMessageActionId))).toBe(
          "message",
        );
    }
    // Messages carry the model's words, not canned replies.
    const sent = responses
      .map((r) => r.messageText)
      .filter((text): text is string => typeof text === "string");
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent).size).toBeGreaterThan(1);
    for (const canned of [
      "We are allied. I will not move on your border while that holds.",
      "Noted. I am open to a pact if you stay off my border.",
      "We share a border. I would rather point my troops elsewhere - pact?",
    ])
      expect(sent).not.toContain(canned);
  });
});
