import {
  CommanderResponseParser,
  MAX_COMMANDER_RESPONSE_LENGTH,
  parseCommanderResponse,
} from "../../src/server/agents/CommanderResponseParser";
import type {
  CommanderResponse,
  ExposedStrategicOption,
  StrategicOptionId,
} from "../../src/server/agents/StrategicCommanderTypes";
import { makeCommanderStage2Fixture } from "./StrategicCommanderStage2TestHarness";

describe("CommanderResponseParser Stage 2", () => {
  it("accepts an exact id from the real locked Stage 1 exposure", () => {
    const fixture = makeCommanderStage2Fixture();
    const selected = requiredOptionID(
      fixture.exposedOptions,
      "pressure_rival:P7",
    );
    const raw = JSON.stringify(validResponse(selected));

    expect(
      new CommanderResponseParser().parse(
        raw,
        lockedOptionIDs(fixture.exposedOptions),
      ),
    ).toEqual({
      ok: true,
      raw,
      selectedStrategicOptionId: selected,
      horizonDecisions: 4,
      intent: "Exploit the opening before another rival absorbs it.",
      replanTriggers: ["target_eliminated", "home_danger_high"],
      confidence: 0.73,
    });
  });

  it("rejects unknown, omitted, whitespace-mutated, and aliased option ids", () => {
    const fixture = makeCommanderStage2Fixture();
    const offered = requiredOptionID(
      fixture.exposedOptions,
      "pressure_rival:P7",
    );
    expect(fixture.strategicOptions.record.omitted).toContainEqual({
      id: "pressure_rival:P9",
      reason: "pressure_target_cap",
    });

    for (const selectedStrategicOptionId of [
      "pressure_rival:P9",
      "pressure_rival:UNKNOWN",
      ` ${offered}`,
      `${offered} `,
      "",
    ]) {
      expect(
        parseCommanderResponse(
          JSON.stringify(
            validResponse(selectedStrategicOptionId as StrategicOptionId),
          ),
          lockedOptionIDs(fixture.exposedOptions),
        ).ok,
      ).toBe(false);
    }

    const aliased = JSON.stringify({
      ...validResponse(offered),
      selectedStrategicOptionId: undefined,
      selectedOptionId: offered,
    });
    expect(
      parseCommanderResponse(aliased, lockedOptionIDs(fixture.exposedOptions))
        .ok,
    ).toBe(false);
  });

  it.each([2, 6])("accepts bounded integer horizon %s", (horizonDecisions) => {
    const fixture = makeCommanderStage2Fixture();
    const response = validResponse(fixture.exposedOptions[0]!.id);
    response.horizonDecisions = horizonDecisions;
    expect(
      parseCommanderResponse(
        JSON.stringify(response),
        lockedOptionIDs(fixture.exposedOptions),
      ).ok,
    ).toBe(true);
  });

  it.each([
    [undefined, 3],
    [1, 2],
    [-1, 2],
    [7, 6],
    [99, 6],
  ])(
    "defaults or clamps integer horizon %s to %s",
    (horizonDecisions, expectedHorizon) => {
      const fixture = makeCommanderStage2Fixture();
      const response: Record<string, unknown> = {
        ...validResponse(fixture.exposedOptions[0]!.id),
      };
      if (horizonDecisions === undefined) {
        delete response.horizonDecisions;
      } else {
        response.horizonDecisions = horizonDecisions;
      }
      expect(
        parseCommanderResponse(
          JSON.stringify(response),
          lockedOptionIDs(fixture.exposedOptions),
        ),
      ).toMatchObject({ ok: true, horizonDecisions: expectedHorizon });
    },
  );

  it.each([null, "4", 2.5])(
    "rejects non-integer horizon %s",
    (horizonDecisions) => {
      const fixture = makeCommanderStage2Fixture();
      const response = {
        ...validResponse(fixture.exposedOptions[0]!.id),
        horizonDecisions,
      };
      expect(
        parseCommanderResponse(
          JSON.stringify(response),
          lockedOptionIDs(fixture.exposedOptions),
        ).ok,
      ).toBe(false);
    },
  );

  it("rejects missing, malformed, unknown, duplicate, and unbounded triggers", () => {
    const fixture = makeCommanderStage2Fixture();
    const base = validResponse(fixture.exposedOptions[0]!.id);
    for (const replanTriggers of [
      undefined,
      null,
      "target_eliminated",
      ["target_dead"],
      ["target_eliminated", "target_eliminated"],
      [
        "horizon_expiry",
        "option_not_executable",
        "target_eliminated",
        "home_danger_high",
        "option_appeared",
        "unknown_trigger",
      ],
    ]) {
      expect(
        parseCommanderResponse(
          JSON.stringify({ ...base, replanTriggers }),
          lockedOptionIDs(fixture.exposedOptions),
        ).ok,
      ).toBe(false);
    }
  });

  it.each([0, 1, undefined])(
    "accepts bounded or omitted confidence %s",
    (confidence) => {
      const fixture = makeCommanderStage2Fixture();
      const response: Record<string, unknown> = {
        ...validResponse(fixture.exposedOptions[0]!.id),
      };
      if (confidence === undefined) {
        delete response.confidence;
      } else {
        response.confidence = confidence;
      }
      expect(
        parseCommanderResponse(
          JSON.stringify(response),
          lockedOptionIDs(fixture.exposedOptions),
        ).ok,
      ).toBe(true);
    },
  );

  it.each([-0.01, 1.01, "0.7", null, Number.NaN, Number.POSITIVE_INFINITY])(
    "drops invalid confidence %s",
    (confidence) => {
      const fixture = makeCommanderStage2Fixture();
      const result = parseCommanderResponse(
        JSON.stringify({
          ...validResponse(fixture.exposedOptions[0]!.id),
          confidence,
        }),
        lockedOptionIDs(fixture.exposedOptions),
      );
      expect(result).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty("confidence");
    },
  );

  it("rejects unknown and duplicate top-level fields", () => {
    const fixture = makeCommanderStage2Fixture();
    const optionID = fixture.exposedOptions[0]!.id;
    expect(
      parseCommanderResponse(
        JSON.stringify({ ...validResponse(optionID), must_follow: true }),
        lockedOptionIDs(fixture.exposedOptions),
      ).ok,
    ).toBe(false);

    const duplicatePrimary = `{"selectedStrategicOptionId":"${optionID}","selectedStrategicOptionId":"pressure_rival:P7","horizonDecisions":4,"intent":"bounded","replanTriggers":[]}`;
    expect(
      parseCommanderResponse(
        duplicatePrimary,
        lockedOptionIDs(fixture.exposedOptions),
      ).ok,
    ).toBe(false);
  });

  it("normalizes and bounds intent without changing the selected option", () => {
    const fixture = makeCommanderStage2Fixture();
    const optionID = fixture.exposedOptions[0]!.id;
    for (const intent of ["", "   ", null]) {
      expect(
        parseCommanderResponse(
          JSON.stringify({ ...validResponse(optionID), intent }),
          lockedOptionIDs(fixture.exposedOptions),
        ).ok,
      ).toBe(false);
    }

    for (const [intent, expectedIntent] of [
      ["Grow east.  Then hold.", "Grow east. Then hold."],
      [" Grow east. ", "Grow east."],
      ["Grow east.\nHold west.", "Grow east. Hold west."],
      ["Grow\u00a0east.", "Grow east."],
      ["hold\u0000\u202e position", "hold position"],
      ["x".repeat(161), `${"x".repeat(159)}…`],
    ]) {
      expect(
        parseCommanderResponse(
          JSON.stringify({ ...validResponse(optionID), intent }),
          lockedOptionIDs(fixture.exposedOptions),
        ),
      ).toMatchObject({
        ok: true,
        selectedStrategicOptionId: optionID,
        intent: expectedIntent,
      });
    }
  });

  it("repairs only wrappers around a complete object and never retargets", () => {
    const fixture = makeCommanderStage2Fixture();
    const optionIDs = fixture.exposedOptions.map((option) => option.id);

    for (const optionID of optionIDs) {
      const json = JSON.stringify(validResponse(optionID));
      for (const wrapped of [
        json,
        `\n\`\`\`json\n${json}\n\`\`\`\n`,
        `Analysis is omitted.\n${json}\nEnd of response.`,
        `prefix ${json} suffix {"selectedStrategicOptionId":"${optionIDs.find((id) => id !== optionID) ?? optionID}"}`,
      ]) {
        const result = parseCommanderResponse(wrapped, optionIDs);
        expect(result).toMatchObject({
          ok: true,
          selectedStrategicOptionId: optionID,
        });
      }
    }
    const truncated = JSON.stringify(validResponse(optionIDs[0]!)).slice(0, -1);
    expect(parseCommanderResponse(truncated, optionIDs).ok).toBe(false);
  });

  it("rejects empty and oversized raw responses before repair", () => {
    const fixture = makeCommanderStage2Fixture();
    expect(
      parseCommanderResponse("", lockedOptionIDs(fixture.exposedOptions)).ok,
    ).toBe(false);
    expect(
      parseCommanderResponse(
        `{${" ".repeat(MAX_COMMANDER_RESPONSE_LENGTH)}}`,
        lockedOptionIDs(fixture.exposedOptions),
      ).ok,
    ).toBe(false);
  });

  it("rejects valid non-object JSON and malformed objects without throwing", () => {
    const fixture = makeCommanderStage2Fixture();
    const response = validResponse(fixture.exposedOptions[0]!.id);

    expect(
      parseCommanderResponse(
        JSON.stringify([response]),
        lockedOptionIDs(fixture.exposedOptions),
      ).ok,
    ).toBe(false);
    expect(
      parseCommanderResponse(
        '{"\\uZZZZ":1}',
        lockedOptionIDs(fixture.exposedOptions),
      ).ok,
    ).toBe(false);
  });
});

function validResponse(
  selectedStrategicOptionId: StrategicOptionId,
): CommanderResponse {
  return {
    selectedStrategicOptionId,
    horizonDecisions: 4,
    intent: "Exploit the opening before another rival absorbs it.",
    replanTriggers: ["target_eliminated", "home_danger_high"],
    confidence: 0.73,
  };
}

function requiredOptionID(
  options: readonly ExposedStrategicOption[],
  id: StrategicOptionId,
): StrategicOptionId {
  const option = options.find((candidate) => candidate.id === id);
  if (option === undefined) {
    throw new Error(`Missing real Stage 1 option fixture: ${id}`);
  }
  return option.id;
}

function lockedOptionIDs(
  options: readonly ExposedStrategicOption[],
): StrategicOptionId[] {
  return options.map((option) => option.id);
}
