import type { TemplateResult } from "lit";
import type {
  WorldModel,
  WorldTheatre,
  WorldTheatreId,
} from "./WorldModelSchema";
import type { FrontDisplayState } from "./WorldPresentation";

/**
 * What `/world`'s sections need from the page: the model, the clock, and
 * the page's helpers for names, colours, emblems, dates and the front
 * drawer. Sections are plain functions of a view, so each lives in its own
 * module and renders in the page's one update.
 */
export interface WorldView {
  readonly model: WorldModel;
  readonly now: number;
  label(name: string | null): string;
  /** Always `#rrggbb`: these values are written into style attributes. */
  bannerColor(name: string | null): string;
  lowContrast(name: string | null): boolean;
  swatch(front: WorldTheatre | null): string;
  emblem(name: string | null, size: number): TemplateResult;
  agentLink(name: string | null, extraClass?: string): TemplateResult;
  frontName(id: WorldTheatreId): string;
  age(iso: string | null): string;
  date(iso: string, withTime?: boolean): string;
  list(items: readonly string[]): string;
  openFront(id: WorldTheatreId): void;
  closeFront(): void;
}

export const STATUS_KEYS: Record<FrontDisplayState, string> = {
  held: "world_page.status_held",
  contested: "world_page.status_contested",
  quiet: "world_page.status_quiet",
  unclaimed: "world_page.status_unclaimed",
};

/** Line icons, injected as trusted markup (they are constants). */
export const ICONS = {
  swords:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l10 10M20 4L10 14"/><path d="M6.5 15.5l2 2M17.5 15.5l-2 2"/><path d="M4 20l3.5-3.5M20 20l-3.5-3.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-6-5.4-6-11a6 6 0 1 1 12 0c0 5.6-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/></svg>',
};
