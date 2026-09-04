import { describe, expect, it, vi } from "vitest";

import {
  coworldRoundListUrl,
  isCoworldRoundListPaginationShapeError,
  readCoworldJson,
} from "../../src/server/agents/CoworldCliRead";

const paginationShapeError = Object.assign(new Error("Command failed"), {
  stderr: [
    "ValidationError: 3 validation errors for RoundListPublic",
    "total_count Field required",
    "limit Field required",
    "offset Field required",
  ].join("\n"),
});

describe("CoworldCliRead", () => {
  it("recognizes only the known round pagination response regression", () => {
    expect(isCoworldRoundListPaginationShapeError(paginationShapeError)).toBe(
      true,
    );
    expect(
      isCoworldRoundListPaginationShapeError(new Error("network timeout")),
    ).toBe(false);
  });

  it("maps supported round-list flags onto the public read endpoint", () => {
    const url = coworldRoundListUrl(
      [
        "rounds",
        "-l",
        "league_1",
        "--division",
        "division_2",
        "--limit",
        "40",
        "--offset",
        "3",
      ],
      "https://example.test/api/",
    );
    expect(url.toString()).toBe(
      "https://example.test/api/observatory/v2/rounds?league_id=league_1&division_id=division_2&limit=40&offset=3",
    );
    expect(() => coworldRoundListUrl(["rounds", "--unknown", "value"])).toThrow(
      /Unsupported Coworld round-list fallback argument/,
    );
  });

  it("uses the fallback only for the exact CLI response-shape failure", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            entries: [{ id: "round_1", status: "completed" }],
            next_cursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      readCoworldJson(["rounds", "-l", "league_1", "--limit", "40"], {
        runCli: async () => {
          throw paginationShapeError;
        },
        fetchImpl,
        server: "https://example.test/api",
      }),
    ).resolves.toEqual({
      entries: [{ id: "round_1", status: "completed" }],
      next_cursor: null,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();

    await expect(
      readCoworldJson(["rounds", "-l", "league_1"], {
        runCli: async () => {
          throw new Error("network timeout");
        },
        fetchImpl,
      }),
    ).rejects.toThrow("network timeout");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("continues to refuse every Coworld mutation verb", async () => {
    await expect(readCoworldJson(["submit", "anything"])).rejects.toThrow(
      "Refusing non-read coworld verb",
    );
  });
});
