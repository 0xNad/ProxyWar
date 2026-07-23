import { afterEach, describe, expect, test, vi } from "vitest";
import { runLoopReplayPremiereAdmission } from "../../../src/scripts/replay-premiere-loop";
import {
  sanitizeReplayPremiereErrorCauseChain,
  type ReplayPremiereErrorTelemetryEntry,
} from "../../../src/server/replay-premiere/ReplayPremiereErrorTelemetry";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";

describe("Replay Premiere loop admission failure telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps the stable operator code and emits the bounded underlying cause chain", async () => {
    const capture = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const leaf = Object.assign(
      new TypeError("renderer rejected checkpoint frame 12"),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
    const execution = Object.assign(
      new Error("renderer process failed to start", { cause: leaf }),
      { code: "ENOEXEC" },
    );
    const failure = new ReplayPremiereError(
      "checkpoint_projection_execution_failed",
      "PREMIERE_INTEGRITY_FAILURE",
      500,
      "Replay Premiere checkpoint eligibility projection failed",
      { cause: execution },
    );

    const result = await runLoopReplayPremiereAdmission({
      args: [],
      premiereId: "prem_aaaaaaaaaaaaaaaaaaaaaaaa",
      bundleSha256: "a".repeat(64),
      environment: {},
      runAdmission: async () => {
        throw failure;
      },
    });

    expect(result).toEqual({
      kind: "release",
      outcome: "admit_failed",
      terminal: false,
    });
    const output = capturedOutput(capture.mock.calls);
    expect(output).toContain(
      "admission failed for prem_aaaaaaaaaaaaaaaaaaaaaaaa: checkpoint_projection_execution_failed cause=",
    );
    expect(output).toContain(
      '"name":"Error","message":"renderer process failed to start","code":"ENOEXEC"',
    );
    expect(output).toContain(
      '"name":"TypeError","message":"renderer rejected checkpoint frame 12","code":"ERR_INVALID_ARG_TYPE"',
    );
  });

  test("redacts paths, credentials, URLs, opaque values, and excess cause depth from the emitted log", async () => {
    const capture = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const hiddenTail = new Error("hidden fifth cause");
    const fourth = new Error("fourth visible cause", { cause: hiddenTail });
    const third = new Error("third visible cause", { cause: fourth });
    const sensitive = Object.assign(
      new Error(
        "open '/Users/operator/Private Data/replay.json' and C:\\Users\\operator\\private.json; " +
          "token=never-log-this-token-value Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 " +
          "from https://private.example.invalid/render?api_key=never-log-this-either",
        { cause: third },
      ),
      { code: "ENOENT" },
    );
    const failure = new ReplayPremiereError(
      "checkpoint_projection_execution_failed",
      "PREMIERE_INTEGRITY_FAILURE",
      500,
      "Replay Premiere checkpoint eligibility projection failed",
      { cause: sensitive },
    );

    await runLoopReplayPremiereAdmission({
      args: [],
      premiereId: "prem_bbbbbbbbbbbbbbbbbbbbbbbb",
      bundleSha256: "b".repeat(64),
      environment: {},
      runAdmission: async () => {
        throw failure;
      },
    });

    const output = capturedOutput(capture.mock.calls);
    expect(output).toContain("checkpoint_projection_execution_failed");
    expect(output).toContain("[path]");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("/Users/operator");
    expect(output).not.toContain("C:\\Users\\operator");
    expect(output).not.toContain("never-log-this");
    expect(output).not.toContain("private.example.invalid");
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(output).not.toContain("hidden fifth cause");

    const entries = sanitizeReplayPremiereErrorCauseChain(failure);
    expect(entries).toHaveLength(4);
    expect(entries.every(withinTelemetryBounds)).toBe(true);
  });

  test("does not reuse a generic error message as the admission operator code", async () => {
    const capture = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    await runLoopReplayPremiereAdmission({
      args: [],
      premiereId: "prem_cccccccccccccccccccccccc",
      bundleSha256: "c".repeat(64),
      environment: {},
      runAdmission: async () => {
        throw new Error(
          "failed under /Users/operator/private token=generic-secret-value",
        );
      },
    });

    const output = capturedOutput(capture.mock.calls);
    expect(output).toContain(
      "admission failed for prem_cccccccccccccccccccccccc: admission_unexpected_error cause=",
    );
    expect(output).toContain("[path]");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("/Users/operator/private");
    expect(output).not.toContain("generic-secret-value");
  });
});

function capturedOutput(calls: unknown[][]): string {
  return calls.map((call) => String(call[0])).join("\n");
}

function withinTelemetryBounds(
  entry: ReplayPremiereErrorTelemetryEntry,
): boolean {
  return (
    entry.name.length <= 48 &&
    (entry.code === undefined || entry.code.length <= 64) &&
    entry.message.length <= 192
  );
}
