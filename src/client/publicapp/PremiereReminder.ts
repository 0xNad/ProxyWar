import { buildIcsEvent, type IcsEventInput } from "./Ics";

/**
 * Pure, framework-agnostic "Remind me" (localStorage-armed, same-tab visual
 * cue + tab title flash) and "Add to calendar" (.ics download) helpers.
 * Shared by every public page that offers a local reminder for a future
 * scheduled event — originally only `LobbyPage`'s Upcoming Premiere hero
 * (state B), now also `MatchDetailPage`'s pre-match state. Purely
 * client-side, no server round-trip, and no push/OS notification: this
 * codebase has no service worker to back that promise, which is why every
 * caller's own "Remind me" button tooltip says so explicitly.
 *
 * `id` is whatever the caller's own event is keyed by — a `premiereId`
 * (`prem_...`) for `LobbyPage`, a `matchId` (`feat_...`) for
 * `MatchDetailPage`. The two id spaces never collide, so one flat
 * localStorage key namespace is safe. The key prefix itself keeps its
 * original `premiere-reminder` spelling from before this extraction, so an
 * already-armed reminder in a returning visitor's browser survives the
 * refactor unchanged.
 */

const REMINDER_KEY_PREFIX = "proxywar:premiere-reminder:";

export type ReminderState = "idle" | "armed" | "fired";

export function readReminderState(id: string): ReminderState {
  try {
    const raw = localStorage.getItem(`${REMINDER_KEY_PREFIX}${id}`);
    return raw === "armed" || raw === "fired" ? raw : "idle";
  } catch {
    return "idle";
  }
}

export function armReminder(id: string): void {
  try {
    localStorage.setItem(`${REMINDER_KEY_PREFIX}${id}`, "armed");
  } catch {
    // Storage unavailable (private browsing, quota) — no-op this session, never a crash.
  }
}

/**
 * Call every tick while the event is upcoming. Fires once, at or after
 * `scheduledAtIso`: marks "fired" in localStorage and flashes the document
 * title so the cue is visible even from a background tab — still requires
 * the tab to stay open (see the "Remind me" button's own tooltip copy).
 * Returns `true` exactly the once it transitions armed -> fired (so the
 * caller knows to re-render its own "fired" cue), `false` on every other
 * tick (not armed, not yet due, or already fired).
 */
export function fireReminderIfDue(
  id: string,
  scheduledAtIso: string,
  nowMs: number,
): boolean {
  if (readReminderState(id) !== "armed") return false;
  const startMs = Date.parse(scheduledAtIso);
  if (Number.isNaN(startMs) || nowMs < startMs) return false;
  try {
    localStorage.setItem(`${REMINDER_KEY_PREFIX}${id}`, "fired");
  } catch {
    // Best effort — the visual cue still renders this tick regardless.
  }
  // Checked without a trailing space: the DOM's title-setting algorithm
  // trims trailing whitespace, so `LIVE: ${title}` against an EMPTY base
  // title normalizes to the stored value "LIVE:" with no trailing space —
  // a `startsWith("LIVE: ")` check would never match its own output in
  // that case and re-prepend the prefix on every subsequent tick.
  if (!document.title.startsWith("LIVE:")) {
    document.title = `LIVE: ${document.title}`;
  }
  return true;
}

/** Builds the .ics in-browser (`Ics.ts`) and offers it as a Blob download — no server round-trip. Caller owns building a spoiler-safe `input.title` (see `Ics.ts`'s own doc on that constraint). */
export function downloadIcsFile(
  input: IcsEventInput,
  filenameStem: string,
): void {
  const ics = buildIcsEvent(input);
  const objectUrl = URL.createObjectURL(
    new Blob([ics], { type: "text/calendar;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${filenameStem}.ics`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
