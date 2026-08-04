import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  coworldStaticReplayUrl,
  loadCoworldStaticReplay,
  parseCoworldStaticReplay,
} from "../../src/client/CoworldStaticReplay";
import {
  RATED_RUN_ID,
  ratedCoworldGameRecordValue,
  ratedCoworldRawReplayValue,
} from "../server/replay-premiere/ReplayPremiereFixtures";

function replayBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("CoworldStaticReplay", () => {
  it.each([
    "coworld_manifest.json",
    "coworld_manifest_template.json",
    "coworld_manifest_ffa16p.json",
  ])("declares the viewer bundle in canonical manifest %s", (filename) => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "coworld-adapter", "coworld", filename),
        "utf8",
      ),
    ) as { game: { replay_viewer?: unknown } };

    expect(manifest.game.replay_viewer).toEqual({
      bundle: "build/static-replay-viewer",
    });
  });

  it("parses the Coworld envelope and validates its embedded game record", () => {
    const replay = parseCoworldStaticReplay(
      replayBytes(ratedCoworldRawReplayValue()),
      "https://replays.example/match.replay",
    );

    expect(replay.runID).toBe(RATED_RUN_ID);
    expect(replay.sourceUrl).toBe("https://replays.example/match.replay");
    expect(replay.gameRecord.info.gameID).toBe("RATE0001");
  });

  it("rejects an invalid embedded game record", () => {
    const envelope = ratedCoworldRawReplayValue();
    envelope.inlineRunArtifacts = {
      "game-record.json": JSON.stringify({ turns: [] }),
    };

    expect(() => parseCoworldStaticReplay(replayBytes(envelope))).toThrow(
      "Embedded game-record.json failed schema validation",
    );
  });

  it("requires Observatory's replay query parameter", () => {
    expect(() => coworldStaticReplayUrl("?turn=10")).toThrow(
      "Missing required replay URL",
    );
    expect(
      coworldStaticReplayUrl(
        "?replay=https%3A%2F%2Freplays.example%2Fmatch.replay",
      ),
    ).toBe("https://replays.example/match.replay");
  });

  it("fetches the replay as opaque bytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify(ratedCoworldRawReplayValue()), {
        status: 200,
      });
    });

    const replay = await loadCoworldStaticReplay({
      search: "?replay=https%3A%2F%2Freplays.example%2Fmatch.replay",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://replays.example/match.replay",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(replay.gameRecord).toEqual(ratedCoworldGameRecordValue());
  });

  it("surfaces replay HTTP failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 403 }),
    );

    await expect(
      loadCoworldStaticReplay({ search: "?replay=denied", fetchImpl }),
    ).rejects.toThrow("Coworld replay returned HTTP 403");
  });
});
