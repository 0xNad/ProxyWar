import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * `coworld-adapter/tester-starter-llm/` is the exact source published as the
 * public `0xNad/proxywar-coworld-starter` repo that `/build` Step 5 and
 * `coworld-adapter/ENTER_THE_LEAGUE.md` send every builder to clone. Uploading
 * a policy (`launch.sh` / `coworld upload-policy`) is NOT the same as
 * entering the league — a builder must also run `coworld leagues` (find the
 * league id) and `coworld submit ... --league <id>` (ENTER_THE_LEAGUE.md's
 * own "Upload and enter" section). Before this fix, every user-facing surface
 * in the starter package instead told the builder to hand their policy id to
 * "whoever is running the match" / "whoever invited you" — a stale,
 * pre-self-serve manual-seating model that left a builder's policy uploaded
 * but never entered into any league, with no error at all (silent drop-off).
 * Verified pre-fix: running these same assertions against the parent commit's
 * original file content (`git show <parent>:coworld-adapter/tester-starter-llm/*`)
 * failed both ways for all three files (no leagues/submit mention, stale
 * phrase present) — proof this check discriminates real content, not a
 * vacuous match.
 */
describe("coworld-adapter/tester-starter-llm league-entry instructions", () => {
  const starterDir = path.join(
    process.cwd(),
    "coworld-adapter",
    "tester-starter-llm",
  );

  it("launch.sh, README.md, and ONBOARDING.md each guide discovery + submission and never fall back to the stale manual hand-off", async () => {
    const [launchSh, readme, onboarding] = await Promise.all([
      fs.readFile(path.join(starterDir, "launch.sh"), "utf8"),
      fs.readFile(path.join(starterDir, "README.md"), "utf8"),
      fs.readFile(path.join(starterDir, "ONBOARDING.md"), "utf8"),
    ]);

    const staleHandoffPhrase = /whoever (is running|invited)/i;
    for (const content of [launchSh, readme, onboarding]) {
      expect(content).toContain("coworld leagues");
      expect(content).toContain("coworld submit");
      expect(content).not.toMatch(/coworld submit[^\n]*:v(?:1|N)\b/i);
      expect(content).not.toMatch(staleHandoffPhrase);
    }
  });

  it("teaches the complete structured-deal loop without claiming a trust score", async () => {
    const [readme, onboarding, deals] = await Promise.all([
      fs.readFile(path.join(starterDir, "README.md"), "utf8"),
      fs.readFile(path.join(starterDir, "ONBOARDING.md"), "utf8"),
      fs.readFile(path.join(starterDir, "DEALS.md"), "utf8"),
    ]);

    for (const content of [readme, onboarding, deals]) {
      expect(content).toContain("dealPolicies");
      expect(content).toContain("breakDealIDs");
      expect(content).toContain("proposalOptions");
    }
    expect(deals).toContain("selectedDealActionId");
    expect(deals).toContain("non_aggression_pact");
    expect(deals).toContain("trade_security_pact");
    expect(deals).toContain("joint_attack");
    expect(deals).toContain("support_request");
    expect(deals).toContain("at least 20% of troops");
    expect(deals).toContain("playerID");
    expect(deals).toContain("dealID");
    expect(deals).toContain("terminal deal evidence");
    expect(deals).not.toMatch(/measures? (?:latent )?trust/i);
  });
});
