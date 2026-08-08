import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression pin for arming PROXYWAR_TUNE_STRUCTURED_DEALS=1 in the hosted
 * Coworld game runnable env (economy+negotiation V1 Phase B;
 * `structuredDealsEnabled` in AgentTunables.ts). Only `game.runnable.env` in
 * the canonical and template manifests reaches the actual hosted game
 * process (`no-docker-coworld-episode.ts` -> `AgentLeagueMatchRunner`, which
 * owns the deal ledger) -- every other shipped variant manifest is
 * untouched. Guards two failure modes: (1) a future edit silently drops the
 * flag from either manifest or lets the two drift apart, and (2) a future
 * edit widens this activation onto an unrelated economy or social flag.
 *
 * This is a manifest-text pin only. The behavioral guarantee that arming
 * STRUCTURED_DEALS alone (DIPLOMACY_SLOTS left unset) still offers complete
 * deal_accept/deal_reject pairs on a crowded >96-action menu is covered by
 * `tests/server/DiplomacyReservedSlots.test.ts` ("STRUCTURED_DEALS=1 alone
 * (DIPLOMACY_SLOTS unset): crowded menu still retains deal_accept/
 * deal_reject") via the real `LegalActionBuilder`, not re-asserted here.
 */

const COWORLD_DIR = path.join(process.cwd(), "coworld-adapter", "coworld");

interface Manifest {
  game: {
    runnable: { env: Record<string, string> };
    protocols: { player: { value: string } };
    docs: { readme: { value: string } };
  };
}

function readManifest(filename: string): Manifest {
  return JSON.parse(
    readFileSync(path.join(COWORLD_DIR, filename), "utf8"),
  ) as Manifest;
}

describe("Coworld manifests: PROXYWAR_TUNE_STRUCTURED_DEALS activation", () => {
  it.each(["coworld_manifest.json", "coworld_manifest_template.json"])(
    "%s arms exactly the structured-deals flag in game.runnable.env",
    (filename) => {
      expect(readManifest(filename).game.runnable.env).toEqual({
        PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
      });
    },
  );

  it.each(["coworld_manifest.json", "coworld_manifest_template.json"])(
    "%s documents the independent structured-deal response slot",
    (filename) => {
      const manifest = readManifest(filename);
      expect(manifest.game.protocols.player.value).toContain(
        "selectedDealActionId?",
      );
      expect(manifest.game.docs.readme.value).toContain(
        "selectedDealActionId may separately select one exact deal_* id",
      );
    },
  );

  // Every other shipped variant stays outside this activation's scope -- it
  // is confined to the canonical + template pair the hosted game process and
  // the publish (template-hydration) pipeline actually read.
  const UNTOUCHED_VARIANTS = [
    "coworld_manifest_ffa4p.json",
    "coworld_manifest_ffa8p.json",
    "coworld_manifest_ffa10p.json",
    "coworld_manifest_ffa12p.json",
    "coworld_manifest_ffa16p.json",
    "coworld_manifest_pr6.json",
  ];

  it.each(UNTOUCHED_VARIANTS)(
    "%s carries no runnable env overrides (unchanged by this activation)",
    (filename) => {
      expect(readManifest(filename).game.runnable.env).toEqual({});
    },
  );

  // The pre-existing diplomacy-slots A/B probe pair predates this change and
  // must stay exactly as shipped: this activation must never fold an
  // unrelated social flag onto the deals flag, nor touch that pair's arm.
  it("leaves the pre-existing diplomacy-slots A/B probe pair unchanged", () => {
    expect(
      readManifest("coworld_manifest_ffa12p_ab_off.json").game.runnable.env,
    ).toEqual({});
    expect(
      readManifest("coworld_manifest_ffa12p_ab_on.json").game.runnable.env,
    ).toEqual({ PROXYWAR_TUNE_DIPLOMACY_SLOTS: "1" });
  });

  it("arms no economy flag anywhere across the shipped manifest set", () => {
    const allManifests = [
      "coworld_manifest.json",
      "coworld_manifest_template.json",
      ...UNTOUCHED_VARIANTS,
      "coworld_manifest_ffa12p_ab_off.json",
      "coworld_manifest_ffa12p_ab_on.json",
    ];
    for (const filename of allManifests) {
      for (const key of Object.keys(readManifest(filename).game.runnable.env)) {
        expect(key).not.toMatch(/^PROXYWAR_TUNE_ECONOMY_/);
      }
    }
  });
});
