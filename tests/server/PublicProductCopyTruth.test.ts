import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface EnglishCopy {
  coworld_league: Record<string, string>;
  about: Record<string, string>;
  build_page: {
    step4: Record<string, string>;
    step5: Record<string, string>;
    step6: Record<string, string>;
  };
}

async function repoText(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

async function englishCopy(): Promise<EnglishCopy> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "resources/lang/en.json"),
      "utf8",
    ),
  ) as EnglishCopy;
}

describe("served public product copy truth", () => {
  it("describes the current league capacity, division, rating, and movement", async () => {
    const copy = await englishCopy();
    const values = [
      copy.coworld_league.standings_provenance,
      copy.coworld_league.league_format_cadence,
      copy.coworld_league.league_format_self_serve,
      copy.about.league_round_cycle,
      copy.about.league_rating,
      copy.about.league_rank,
      copy.about.self_serve_step_4_text,
    ].join("\n");

    expect(values).toContain("up to 16 agents");
    expect(values).toContain("directly to the league's Competition division");
    expect(values).toContain("rating from completed round results");
    expect(values).toContain("does not retain previous rank snapshots");
    expect(values).not.toMatch(
      /up to 12|Qualifiers|graduate|rolling rating|Movement is real-time/u,
    );
  });

  it("states the territorial adjudication and bounded synchronous planner refresh", async () => {
    const [copy, entryGuide, starterReadme, onboarding] = await Promise.all([
      englishCopy(),
      repoText("coworld-adapter/ENTER_THE_LEAGUE.md"),
      repoText("coworld-adapter/tester-starter-llm/README.md"),
      repoText("coworld-adapter/tester-starter-llm/ONBOARDING.md"),
    ]);

    expect(copy.about.match_step_5_text).toContain(
      "60-simulated-minute adjudication",
    );
    expect(copy.build_page.step4.contract_timeout).toContain(
      "on a scheduled refresh it waits up to 12 seconds",
    );
    expect(copy.build_page.step4.contract_timeout).not.toMatch(
      /background-refreshed|answers immediately from/u,
    );
    expect(copy.build_page.step5.graduation_note).not.toContain("Qualifiers");
    expect(copy.build_page.step6.qualifier_passed).not.toContain("Qualifiers");
    expect(entryGuide).toContain("up to 16 seats");
    expect(entryGuide).not.toMatch(/2\/4\/8|12-seat|16-seat rungs/u);
    for (const document of [entryGuide, starterReadme, onboarding]) {
      expect(document).toMatch(/60(?:-second| seconds per) decision/u);
      expect(document).toContain("15-second internal planning budget");
      expect(document).not.toContain("canonical 15-second decision");
    }
  });
});
