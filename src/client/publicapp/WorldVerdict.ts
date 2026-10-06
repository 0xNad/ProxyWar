import { html, type TemplateResult } from "lit";
import { translateText } from "../Utils";
import { leaderCaveats, regionFronts } from "./HomePresentation";
import { mix } from "./WorldMapRenderer";
import type { WorldModel, WorldTheatreId } from "./WorldModelSchema";
import { hexToRgb, rgbHex, worldVerdict } from "./WorldPresentation";
import {
  formatList,
  frontInText,
  modeKey,
  nameMarker,
  splice,
  spliceList,
} from "./WorldText";

/**
 * The state of the war in a headline and the sentence under it: who is
 * winning (or that no one is), what the lead rests on and what threatens
 * it. Shared by the front page and /world so the two never word it
 * differently.
 */

/**
 * The class on a lead's second weak spot, which both pages hide on narrow
 * screens. Their stylesheets interpolate it, so a rename reaches both.
 */
export const CAVEAT_MORE_CLASS = "hp-caveat-more";

/** What a page lends the verdict: its names, dates and clock. */
export interface VerdictView {
  readonly now: number;
  label(name: string): string;
  frontName(id: WorldTheatreId): string;
  date(iso: string): string;
  /** A leader's name in the headline, drawn the page's way. */
  leadName(name: string): TemplateResult;
}

/**
 * The colour that underlines a leader's name: its banner colour, lifted
 * towards white where the banner is too dark to see on the page.
 */
export function leadUnderline(color: string, lowContrast: boolean): string {
  const rgb = hexToRgb(color);
  if (rgb === null) return "#a4afbf";
  return lowContrast ? rgbHex(mix(rgb, [255, 255, 255], 0.45)) : rgbHex(rgb);
}

/** "Matt Van is winning.", "Alpha and Matt Van share the lead.", and so on. */
export function renderVerdict(
  view: VerdictView,
  model: WorldModel,
): TemplateResult | string {
  const verdict = worldVerdict(model);
  switch (verdict.kind) {
    case "leader":
      return splice("home_page.verdict_leader", { name: nameMarker(0) }, [
        view.leadName(verdict.name),
      ]);
    case "tied":
      return verdict.names.length === 2
        ? splice(
            "home_page.verdict_tied_two",
            { first: nameMarker(0), second: nameMarker(1) },
            verdict.names.map((name) => view.leadName(name)),
          )
        : translateText(modeKey(model, "home_page.verdict_tied_many"), {
            count: verdict.names.length,
          });
    case "scattered":
      return translateText(modeKey(model, "home_page.verdict_scattered"));
    case "empty":
      return translateText("home_page.verdict_empty");
  }
}

/**
 * How long the names in the headline run, so a page can size it: "s" up
 * to 16 characters, then "m", "l" and, past 40, "xl".
 */
export function verdictLength(
  view: VerdictView,
  model: WorldModel,
): "s" | "m" | "l" | "xl" {
  const verdict = worldVerdict(model);
  const names =
    verdict.kind === "leader"
      ? [verdict.name]
      : verdict.kind === "tied" && verdict.names.length === 2
        ? verdict.names
        : [];
  const longest = Math.max(0, ...names.map((name) => view.label(name).length));
  return longest > 40 ? "xl" : longest > 28 ? "l" : longest > 16 ? "m" : "s";
}

/**
 * The sentence under the headline: how many fronts the lead rests on and
 * which, then up to two weak spots (a siege, a front gone quiet). The
 * second weak spot is marked `CAVEAT_MORE_CLASS` so narrow screens can
 * drop it.
 */
export function renderSupport(
  view: VerdictView,
  model: WorldModel,
): TemplateResult | string {
  const verdict = worldVerdict(model);
  const total = regionFronts(model).length;
  const holding = (count: number) =>
    html`<b
      >${translateText("home_page.support_holding", { count, total })}</b
    >`;
  switch (verdict.kind) {
    case "leader": {
      const held = regionFronts(model).filter(
        (front) => front.holder === verdict.name,
      );
      const caveats = leaderCaveats(model, verdict.name, view.now).map(
        (caveat, index) =>
          html` <span class=${index > 0 ? CAVEAT_MORE_CLASS : ""}
            >${caveat.kind === "siege"
              ? translateText("home_page.caveat_siege", {
                  front: frontInText(caveat.front.id),
                  challenger: view.label(caveat.front.challenger ?? ""),
                  wins: caveat.front.holderWins,
                })
              : translateText("home_page.caveat_quiet", {
                  front: frontInText(caveat.front.id),
                  date: view.date(caveat.front.lastBattleAt ?? ""),
                })}</span
          >`,
      );
      return html`${splice(
        "home_page.support_leader",
        { holding: nameMarker(0), fronts: nameMarker(1) },
        [
          holding(verdict.fronts),
          spliceList(
            held.map((front) => html`<b>${view.frontName(front.id)}</b>`),
          ),
        ],
      )}${caveats}`;
    }
    case "tied":
      return verdict.names.length === 2
        ? splice(
            modeKey(model, "home_page.support_tied"),
            { holding: nameMarker(0) },
            [holding(verdict.fronts)],
          )
        : splice(
            modeKey(model, "home_page.support_tied_many"),
            {
              names: formatList(verdict.names.map((name) => view.label(name))),
              holding: nameMarker(0),
            },
            [holding(verdict.fronts)],
          );
    case "scattered":
      return translateText(modeKey(model, "home_page.support_scattered"), {
        count: verdict.claimed,
      });
    case "empty":
      return translateText(modeKey(model, "home_page.support_empty"));
  }
}
