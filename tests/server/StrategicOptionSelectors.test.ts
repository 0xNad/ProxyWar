import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CommanderState,
  ExposedStrategicOption,
} from "../../src/server/agents/StrategicCommanderTypes";
import { selectDeterministicStrategicOption } from "../../src/server/agents/StrategicOptionSelectors";
import { makeCommanderStage2Fixture } from "./StrategicCommanderStage2TestHarness";

function fixtureState(
  options: readonly ExposedStrategicOption[] = makeCommanderStage2Fixture()
    .builtState.state.options,
): CommanderState {
  return {
    ...makeCommanderStage2Fixture().builtState.state,
    options: options.map((option) => ({
      ...option,
      evidence: { ...option.evidence },
    })),
  };
}

function family(
  state: CommanderState,
  wanted: ExposedStrategicOption["family"],
): ExposedStrategicOption {
  const option = state.options.find((candidate) => candidate.family === wanted);
  if (option === undefined) throw new Error(`missing ${wanted} fixture option`);
  return option;
}

describe("DeterministicOptionSelector Stage 4 control policy", () => {
  it("uses the fixed danger, pressure, economy, expand, survive branch order", () => {
    const danger = fixtureState();
    const dangerSurvive = family(danger, "survive");
    dangerSurvive.evidence = {
      ...dangerSurvive.evidence,
      incomingAttackCount: 1,
      strongerBorderRivalCount: 1,
    };
    expect(
      selectDeterministicStrategicOption(danger, danger.options)
        .selectedStrategicOptionId,
    ).toBe("survive");

    const pressure = fixtureState();
    expect(
      selectDeterministicStrategicOption(pressure, pressure.options)
        .selectedStrategicOptionId,
    ).toBe("pressure_rival:P7");

    const economy = fixtureState(
      fixtureState().options.filter(
        (option) => option.family !== "pressure_rival",
      ),
    );
    expect(
      selectDeterministicStrategicOption(economy, economy.options)
        .selectedStrategicOptionId,
    ).toBe("develop_economy");

    const expand = fixtureState(
      fixtureState().options.filter(
        (option) => option.family === "expand" || option.family === "survive",
      ),
    );
    expect(
      selectDeterministicStrategicOption(expand, expand.options)
        .selectedStrategicOptionId,
    ).toBe("expand");

    const survive = fixtureState([family(fixtureState(), "survive")]);
    expect(
      selectDeterministicStrategicOption(survive, survive.options)
        .selectedStrategicOptionId,
    ).toBe("survive");
  });

  it("selects the first qualifying pressure target in locked exposure order", () => {
    const base = fixtureState();
    const p7 = base.options.find(
      (option) => option.id === "pressure_rival:P7",
    )!;
    const p8 = base.options.find(
      (option) => option.id === "pressure_rival:P8",
    )!;
    const qualifyingP8: ExposedStrategicOption = {
      ...p8,
      evidence: { ...p8.evidence, sharesBorder: true },
    };
    const options = [qualifyingP8, p7];
    const state = fixtureState(options);

    const selected = selectDeterministicStrategicOption(state, state.options);
    expect(selected).toEqual({
      selectedStrategicOptionId: "pressure_rival:P8",
      horizonDecisions: 3,
      intent: "deterministic control selected pressure_rival",
      replanTriggers: [],
    });
  });

  it("rejects any option surface that is not the exact locked state surface", () => {
    const state = fixtureState();
    expect(() =>
      selectDeterministicStrategicOption(state, state.options.slice(1)),
    ).toThrow(/do not match locked state/);
  });

  it("has only the bounded Commander state and exposed-option authority", () => {
    expect(selectDeterministicStrategicOption).toHaveLength(2);
    const source = readFileSync(
      path.join(process.cwd(), "src/server/agents/StrategicOptionSelectors.ts"),
      "utf8",
    );

    const executableSource = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(executableSource).not.toMatch(
      /AgentPlannerExecutor|AgentStrategicSkills|AgentTacticalAffordances|AgentStrategicStateBuilder|LegalActionBuilder|AgentObservation|AgentBrainInput|totalScore|strategicScore|policyScore|skillScore/,
    );
    expect(
      [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(["./StrategicCommanderTypes"]);
  });
});
