import { describe, expect, it } from "vitest";
import {
  boundedFixtureCommandDiagnostics,
  FIXTURE_DIAGNOSTIC_RAW_INPUT_LIMIT,
  fixtureCommandFailureError,
} from "./FixtureServer";

describe("fixture subprocess diagnostics", () => {
  it("emits only fixed canonical diagnostics and never retains the raw child error", () => {
    const unknownCredentialMarker = "UNRECOGNIZED_CREDENTIAL_MARKER_83f0";
    const privateRoot = "/private/tmp/e2e-live-private-root";
    const childError = {
      code: 1,
      message: "Command failed: bash fixture-script.sh",
      stderr: `${privateRoot}/ReplayPremiereControlledExecution.ts:159 Error: controlled execution config contains unknown or missing fields\n${unknownCredentialMarker}`,
      stdout: "ordinary progress must stay out of CI",
    };
    const diagnostic = boundedFixtureCommandDiagnostics(childError);

    expect(diagnostic).toContain("exit code: 1");
    expect(diagnostic).toContain(
      "stderr: controlled_execution_config_unknown_or_missing_fields",
    );
    expect(diagnostic).not.toContain(unknownCredentialMarker);
    expect(diagnostic).not.toContain(privateRoot);
    expect(diagnostic).not.toContain("ordinary progress");
    expect(diagnostic.length).toBeLessThanOrEqual(4_096);

    const wrapped = fixtureCommandFailureError(childError);
    const serialized = [
      wrapped.message,
      wrapped.stack ?? "",
      JSON.stringify(wrapped),
    ].join("\n");
    expect(wrapped.cause).toBeUndefined();
    expect(serialized).not.toContain(privateRoot);
    expect(serialized).not.toContain(unknownCredentialMarker);
  });

  it("caps oversized raw inputs before signature matching", () => {
    const signature =
      "controlled execution config contains unknown or missing fields";
    const unknownCredentialMarker = "OVERSIZED_UNKNOWN_CREDENTIAL_55aa";
    const half = "x".repeat(8 * 1024 * 1024);
    const middleOnly = boundedFixtureCommandDiagnostics({
      code: 1,
      stderr: `${half}${signature}${unknownCredentialMarker}${half}`,
    });
    expect(FIXTURE_DIAGNOSTIC_RAW_INPUT_LIMIT).toBe(8_192);
    expect(middleOnly).not.toContain(
      "controlled_execution_config_unknown_or_missing_fields",
    );
    expect(middleOnly).not.toContain(unknownCredentialMarker);

    const tailMatch = boundedFixtureCommandDiagnostics({
      code: 1,
      stderr: `${half}${unknownCredentialMarker}${signature}`,
    });
    expect(tailMatch).toContain(
      "stderr: controlled_execution_config_unknown_or_missing_fields",
    );
    expect(tailMatch).not.toContain(unknownCredentialMarker);
  });
});
