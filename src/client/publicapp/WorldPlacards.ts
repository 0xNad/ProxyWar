import { html, nothing, svg, type TemplateResult } from "lit";
import { translateText } from "../Utils";
import { crownFront, regionFronts, type RegionFront } from "./HomePresentation";
import { CROWN_GLYPH } from "./WorldGlyphs";
import { WORLD_GRID_ANCHORS } from "./WorldMapGrid";
import type {
  WorldModel,
  WorldTheatre,
  WorldTheatreId,
} from "./WorldModelSchema";
import { frontDisplayState, type FrontDisplayState } from "./WorldPresentation";

/**
 * The map's placards, shared by the front page and `/world` so the same map
 * reads the same on both. Each held front is tagged with its holder's flag
 * and name and, under them, the front and its state ("Asia, taken 1 h 44
 * min ago", "Black Sea, under siege" and who drew level). An unclaimed
 * front is lettered on the land, and the Crown, which holds no land, is a
 * seal in open water. Below 1180 px the placards give way to each page's
 * legend and the seal shrinks to a disc.
 *
 * The pages differ only in where a placard goes (a link to `/world` from
 * the front page, the front's sheet on `/world`), its accessible name, and
 * what an unclaimed front says.
 */

export const VACANT_RING = "#46556c";

/**
 * Placards sit on the shared label anchors; only fronts whose anchor is in
 * a crowded or tiny spot are nudged (offsets in % of the map box). East
 * Asia's placard moves out to sea and keeps a leader line to its anchor.
 */
const PLACARD_PLACEMENT: Partial<
  Record<
    WorldTheatreId,
    {
      readonly align?: "left" | "right";
      readonly dx?: number;
      readonly dy?: number;
      readonly leader?: boolean;
    }
  >
> = {
  britannia: { align: "left", dx: 2.2 },
  europe: { dx: -1.4 },
  black_sea: { align: "right", dx: 0.8 },
  middle_east: { dy: 1.5 },
  east_asia: { align: "right", dx: 2.5, dy: 7.5, leader: true },
};

/** Where a placard goes: a link, or an action on the page. */
export type PlacardTarget =
  | { readonly href: string }
  | { readonly open: () => void };

export interface PlacardView {
  readonly now: number;
  label(name: string): string;
  /** Always `#rrggbb`: these values are written into style attributes. */
  colorOf(name: string | null): string;
  swatch(front: WorldTheatre | null): string;
  lowContrast(name: string | null): boolean;
  /** The holder's pixel emblem as an image, or nothing. */
  emblem(name: string | null): TemplateResult | typeof nothing;
  frontName(id: WorldTheatreId): string;
  age(iso: string): string;
  date(iso: string): string;
  target(id: WorldTheatreId): PlacardTarget;
  /** Accessible name of a held front's placard. */
  placardAria(front: RegionFront, holder: string): string;
  /** Accessible name of an unclaimed front's lettering. */
  openAria(front: RegionFront): string;
  /** What an unclaimed front's lettering says under its name. */
  openLine(front: RegionFront): string;
  /** Accessible name of the Crown's seal. */
  sealAria(holder: string | null): string;
  /** Pointing at or focusing a placard (and leaving it), for map highlights. */
  focusFront?(id: WorldTheatreId | null): void;
  /** Fronts to mark as changed since the visitor's last visit. */
  readonly changed?: readonly WorldTheatreId[];
}

export function renderPlacards(
  view: PlacardView,
  model: WorldModel,
): TemplateResult {
  const leaders: TemplateResult[] = [];
  const placards = regionFronts(model).map((front) => {
    const anchor = WORLD_GRID_ANCHORS[front.id];
    const place = PLACARD_PLACEMENT[front.id] ?? {};
    const x = anchor.x + (place.dx ?? 0);
    const y = anchor.y + (place.dy ?? 0);
    const display = frontDisplayState(front, view.now);
    if (display === "unclaimed" || front.holder === null) {
      return html`<li class="hp-placard-full">
        ${opener(
          view,
          front.id,
          {
            className: "hp-open",
            style: `left:${x}%;top:${y}%`,
            label: view.openAria(front),
          },
          html`<b>${view.frontName(front.id)}</b>
            <span>${view.openLine(front)}</span>`,
        )}
      </li>`;
    }
    if (place.leader === true) {
      leaders.push(
        svg`<line x1=${anchor.x} y1=${anchor.y} x2=${x} y2=${y}></line>`,
      );
    }
    const holder = front.holder;
    const siege =
      display === "contested" && front.challenger !== null
        ? html`<span
            class="hp-mark-siege"
            style="--rival:${view.colorOf(front.challenger)}"
            ><i class=${view.lowContrast(front.challenger) ? "hp-low" : ""}></i
            >${translateText("home_page.mark_level", {
              challenger: view.label(front.challenger),
              wins: front.challengerWins,
            })}</span
          >`
        : nothing;
    return html`<li class="hp-placard-full">
      ${opener(
        view,
        front.id,
        {
          className: "hp-mark",
          state: display,
          align: place.align ?? "center",
          style: `left:${x}%;top:${y}%;--frame:${view.swatch(front)}`,
          label: view.placardAria(front, holder),
        },
        html`<span class="hp-flag ${view.lowContrast(holder) ? "hp-low" : ""}"
            >${view.emblem(holder)}</span
          ><span class="hp-mark-text"
            ><span class="hp-mark-name">${view.label(holder)}</span>
            <span class="hp-mark-detail">${placardDetail(view, front)}</span>
            ${siege}</span
          >`,
      )}
    </li>`;
  });
  return html`<svg
      class="hp-leaders hp-placard-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      ${leaders}
    </svg>
    <ul class="hp-marks" aria-label=${translateText("home_page.map_aria")}>
      ${placards}${renderSeal(view, model)}
    </ul>`;
}

/** The front and its state, under the holder's name. */
function placardDetail(view: PlacardView, front: RegionFront): string {
  const name = view.frontName(front.id);
  const display = frontDisplayState(front, view.now);
  if (display === "quiet" && front.lastBattleAt !== null) {
    return translateText("home_page.mark_quiet", {
      front: name,
      date: view.date(front.lastBattleAt),
    });
  }
  if (display === "contested") {
    return translateText("home_page.mark_siege", { front: name });
  }
  if (front.heldSince === null) return name;
  const since = Date.parse(front.heldSince);
  return Number.isFinite(since) && view.now - since < 24 * 60 * 60 * 1000
    ? translateText("home_page.mark_taken", {
        front: name,
        age: view.age(front.heldSince),
      })
    : translateText("home_page.mark_held_since", {
        front: name,
        date: view.date(front.heldSince),
      });
}

/** The Crown holds no land, so it sits in open water as a seal — never omitted. */
function renderSeal(view: PlacardView, model: WorldModel): TemplateResult {
  const crown = crownFront(model);
  const anchor = WORLD_GRID_ANCHORS.crown;
  const holder = crown?.holder ?? null;
  return html`<li class="hp-seal-item">
    ${opener(
      view,
      "crown",
      {
        className: "hp-seal",
        style: `left:${anchor.x}%;top:${anchor.y}%;--ring:${
          holder === null ? VACANT_RING : view.colorOf(holder)
        }`,
        label: view.sealAria(holder),
      },
      html`<span
          class="hp-seal-disc ${view.lowContrast(holder) ? "hp-low" : ""}"
          ><span class="hp-seal-crown">${CROWN_GLYPH}</span>${view.emblem(
            holder,
          )}</span
        ><span class="hp-seal-text"
          ><span class="hp-seal-title"
            >${translateText("home_page.crown_title")}</span
          >
          <span class="hp-seal-name"
            >${holder === null
              ? translateText("home_page.crown_vacant")
              : view.label(holder)}</span
          >
          <span class="hp-seal-detail"
            >${translateText("home_page.crown_note")}</span
          >
          ${crown !== null &&
          crown.challenger !== null &&
          frontDisplayState(crown, view.now) === "contested"
            ? html`<span
                class="hp-mark-siege"
                style="--rival:${view.colorOf(crown.challenger)}"
                ><i
                  class=${view.lowContrast(crown.challenger) ? "hp-low" : ""}
                ></i
                >${translateText("home_page.mark_level", {
                  challenger: view.label(crown.challenger),
                  wins: crown.challengerWins,
                })}</span
              >`
            : nothing}
          ${holder !== null && crown?.heldSince
            ? html`<span class="hp-seal-detail"
                >${translateText("home_page.crown_taken", {
                  age: view.age(crown.heldSince),
                })}</span
              >`
            : nothing}</span
        >`,
    )}
  </li>`;
}

/** A placard as a link (front page) or a button opening the front (`/world`). */
function opener(
  view: PlacardView,
  id: WorldTheatreId,
  part: {
    readonly className: string;
    readonly style: string;
    readonly label: string;
    readonly state?: FrontDisplayState;
    readonly align?: string;
  },
  content: TemplateResult,
): TemplateResult {
  const target = view.target(id);
  const changed = view.changed?.includes(id) ?? false;
  const focus = view.focusFront;
  const enter = focus === undefined ? undefined : () => focus(id);
  const leave = focus === undefined ? undefined : () => focus(null);
  if ("href" in target) {
    return html`<a
      class=${part.className}
      data-state=${part.state ?? nothing}
      data-align=${part.align ?? nothing}
      ?data-changed=${changed}
      href=${target.href}
      style=${part.style}
      aria-label=${part.label}
      @pointerenter=${enter}
      @pointerleave=${leave}
      @focus=${enter}
      @blur=${leave}
      >${content}</a
    >`;
  }
  return html`<button
    type="button"
    class=${part.className}
    data-state=${part.state ?? nothing}
    data-align=${part.align ?? nothing}
    ?data-changed=${changed}
    style=${part.style}
    aria-label=${part.label}
    aria-haspopup="dialog"
    @pointerenter=${enter}
    @pointerleave=${leave}
    @focus=${enter}
    @blur=${leave}
    @click=${(event: Event) => {
      event.stopPropagation();
      target.open();
    }}
  >
    ${content}
  </button>`;
}

const STYLE_ELEMENT_ID = "world-placard-styles";

/** The placards' styles, once per document, for whichever page shows them. */
export function ensurePlacardStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = PLACARD_CSS;
  document.head.appendChild(style);
}

const PLACARD_CSS = `
.hp-marks{--hp-plate:rgb(4 10 23/.92);--hp-ink:#edf1f7;--hp-ink-2:#a4afbf;--hp-sea:#071225;position:absolute;inset:0;margin:0;padding:0;list-style:none;pointer-events:none;font-family:"PW Overpass",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--hp-ink)}
.hp-marks a,.hp-marks button{pointer-events:auto}
:where(.hp-marks) button{margin:0;border:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.hp-leaders{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.hp-leaders line{stroke:var(--hp-ink,#edf1f7);stroke-width:1;vector-effect:non-scaling-stroke;opacity:.7}
.hp-mark{position:absolute;display:flex;align-items:flex-start;gap:8px;width:max-content;max-width:256px;padding:4px 10px 5px 4px;background:var(--hp-plate);color:var(--hp-ink);text-decoration:none;transform:translate(-50%,-50%)}
.hp-mark[data-align="left"]{transform:translate(calc(-100% - 4px),-50%)}
.hp-mark[data-align="right"]{transform:translate(4px,-50%)}
.hp-mark[data-changed],.hp-open[data-changed]{outline:2px solid var(--hp-ink);outline-offset:2px}
.hp-flag{flex:none;display:block;width:32px;height:32px;padding:3px;background:var(--frame)}
.hp-flag img{display:block;width:26px;height:26px;image-rendering:pixelated}
.hp-low{box-shadow:inset 0 0 0 1px var(--hp-ink,#edf1f7)}
.hp-mark-text{display:flex;flex-direction:column;min-width:0;padding-top:1px}
.hp-mark-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.15;font-weight:700;text-wrap:balance;overflow-wrap:anywhere}
.hp-mark-detail{font-size:12px;line-height:1.3;color:var(--hp-ink-2)}
.hp-mark-siege{display:flex;align-items:center;gap:5px;font-size:12px;line-height:1.3}
.hp-mark-siege i{flex:none;width:10px;height:10px;background:var(--rival)}
.hp-mark[data-state="quiet"] .hp-mark-name{color:#cdd4de}
.hp-mark:hover .hp-mark-name,.hp-open:hover b,.hp-seal:hover .hp-seal-name{text-decoration:underline;text-underline-offset:2px}
.hp-open{position:absolute;transform:translate(-50%,-50%);padding:0;background:none;text-align:center;text-decoration:none;line-height:1.25;white-space:nowrap}
.hp-open b{display:block;font-size:13px;font-weight:700}
.hp-open span{font-size:12px;color:var(--hp-ink-2)}
.hp-seal{position:absolute;display:flex;align-items:center;gap:12px;padding:0;background:none;text-decoration:none;transform:translate(-32px,-50%)}
.hp-seal-disc{position:relative;flex:none;display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--hp-plate);box-shadow:inset 0 0 0 3px var(--ring)}
.hp-seal-disc.hp-low{box-shadow:inset 0 0 0 3px var(--ring),inset 0 0 0 4px var(--hp-ink)}
.hp-seal-disc img{width:30px;height:30px;image-rendering:pixelated}
.hp-seal-crown{position:absolute;left:50%;top:-8px;width:28px;height:14px;padding:0 4px 2px;background:var(--hp-sea);transform:translateX(-50%)}
.hp-seal-crown svg{display:block;width:100%;height:100%;fill:var(--hp-ink)}
.hp-seal-text{display:flex;flex-direction:column;max-width:15em;line-height:1.25}
.hp-seal-title,.hp-seal-detail{font-size:12px;color:var(--hp-ink-2)}
.hp-seal-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15px;font-weight:700;overflow-wrap:anywhere}
@media (max-width:1179px){
  .hp-placard-full{display:none}
  .hp-seal{gap:0;transform:translate(-50%,-50%)}
  .hp-seal::after{content:"";position:absolute;inset:-10px}
  .hp-seal-text{display:none}
  .hp-seal-disc{width:30px;height:30px;box-shadow:inset 0 0 0 2px var(--ring)}
  .hp-seal-disc img{width:14px;height:14px}
  .hp-seal-crown{width:16px;height:9px;top:-5px;padding:0 3px 1px}
}
@media (max-width:759px){
  .hp-seal-disc{width:24px;height:24px}
  .hp-seal-disc img{width:12px;height:12px}
  .hp-seal-crown{width:14px;height:8px;top:-5px}
}
`;
