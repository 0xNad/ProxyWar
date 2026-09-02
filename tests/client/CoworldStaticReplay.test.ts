import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coworldStaticReplayUrl,
  loadCoworldStaticReplay,
  parseCoworldStaticReplay,
  sniffReplayCompression,
} from "../../src/client/CoworldStaticReplay";
import {
  clearSpectatorReplay,
  publishSpectatorReplay,
  spectatorReplaySnapshots,
} from "../../src/client/SpectatorReplayStore";
import {
  RATED_RUN_ID,
  ratedCoworldGameRecordValue,
  ratedCoworldRawReplayValue,
} from "../server/replay-premiere/ReplayPremiereFixtures";

function replayBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const REPLAY_LOCATION = {
  hash: "",
  search: "?replay=https%3A%2F%2Freplays.example%2Fmatch.replay",
};

/** Stand in as the embedding Observatory window so host posts are observable. */
function embedInHost(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(window, "parent", {
    value: { postMessage },
    configurable: true,
    writable: true,
  });
  return postMessage;
}

describe("CoworldStaticReplay", () => {
  afterEach(() => {
    Object.defineProperty(window, "parent", {
      value: window,
      configurable: true,
      writable: true,
    });
  });

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
      replay_compression: "gzip",
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

  it("clears a static match's snapshot store before a hosted replay transition", () => {
    publishSpectatorReplay({
      snapshots: [
        { turnNumber: 100, players: [{ username: "A", tilesOwned: 10 }] },
        { turnNumber: 200, players: [{ username: "A", tilesOwned: 20 }] },
      ],
    });
    expect(spectatorReplaySnapshots()).not.toBeNull();

    clearSpectatorReplay();
    expect(spectatorReplaySnapshots()).toBeNull();
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

  it("reads the replay URL from the fragment first, then the legacy query", () => {
    expect(() =>
      coworldStaticReplayUrl({ hash: "#turn=10", search: "?turn=10" }),
    ).toThrow("Missing required replay URL");
    expect(coworldStaticReplayUrl(REPLAY_LOCATION)).toBe(
      "https://replays.example/match.replay",
    );
    expect(
      coworldStaticReplayUrl({
        hash: "#replay=https%3A%2F%2Freplays.example%2Ffragment.replay",
        search: "?replay=https%3A%2F%2Freplays.example%2Fquery.replay",
      }),
    ).toBe("https://replays.example/fragment.replay");
  });

  it("sniffs compression from the bytes, not the URL", () => {
    const json = replayBytes({ a: 1 });
    expect(sniffReplayCompression(json)).toBeNull();
    expect(sniffReplayCompression(new Uint8Array(gzipSync(json)))).toBe("gzip");
    expect(sniffReplayCompression(new Uint8Array(deflateSync(json)))).toBe(
      "deflate",
    );
  });

  it("fetches the replay as opaque bytes and reports phases to the host", async () => {
    const postMessage = embedInHost();
    const body = JSON.stringify(ratedCoworldRawReplayValue());
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(body, { status: 200 });
    });

    const replay = await loadCoworldStaticReplay({
      location: REPLAY_LOCATION,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://replays.example/match.replay",
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    );
    expect(replay.gameRecord).toEqual(ratedCoworldGameRecordValue());
    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      { src: "coworld-replay", type: "phase", phase: "replay_fetch_start" },
      {
        src: "coworld-replay",
        type: "phase",
        phase: "replay_fetch_end",
        bytes: new TextEncoder().encode(body).byteLength,
        compressed: false,
      },
      { src: "coworld-replay", type: "phase", phase: "replay_parsed" },
    ]);
    expect(postMessage.mock.calls.every((call) => call[1] === "*")).toBe(true);
  });

  it.each([
    ["gzip", gzipSync],
    ["zlib", deflateSync],
  ])("inflates a %s public replay copy", async (_name, compress) => {
    const postMessage = embedInHost();
    const compressed = new Uint8Array(
      compress(Buffer.from(JSON.stringify(ratedCoworldRawReplayValue()))),
    );
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(compressed, { status: 200 }),
    );

    const replay = await loadCoworldStaticReplay({
      location: REPLAY_LOCATION,
      fetchImpl,
    });

    expect(replay.gameRecord).toEqual(ratedCoworldGameRecordValue());
    expect(postMessage).toHaveBeenCalledWith(
      {
        src: "coworld-replay",
        type: "phase",
        phase: "replay_fetch_end",
        bytes: compressed.byteLength,
        compressed: true,
      },
      "*",
    );
  });

  it("surfaces replay HTTP failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 403 }),
    );

    await expect(
      loadCoworldStaticReplay({
        location: { hash: "", search: "?replay=denied" },
        fetchImpl,
      }),
    ).rejects.toThrow("Coworld replay returned HTTP 403");
  });
});
