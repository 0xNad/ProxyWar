/**
 * Pure RFC 5545 (iCalendar) single-VEVENT builder for the "Add to calendar"
 * action on the Upcoming Premiere hero (state B, `LobbyPage.renderHeroUpcomingPremiere`).
 * Client-side only, no server round-trip — the caller turns the returned
 * string into a `Blob` and offers it as a `<a download>` link.
 *
 * Deliberately takes ONLY already-public-safe fields (title text, an ISO
 * timestamp, a URL) — never a participant name. Callers must build `title`
 * from `CoworldLeaguePremiereCard`'s five spoiler-safe fields only (round
 * number, map label), same constraint as the hero itself.
 */

export interface IcsEventInput {
  /** Already-safe copy, e.g. "Proxy War Premiere — Round 12 (Ashfields)". */
  title: string;
  /** ISO-8601 scheduled start time. */
  scheduledAt: string;
  /** Absolute URL to the event's own page (used for both DESCRIPTION and URL). */
  url: string;
}

const CRLF = "\r\n";
/** RFC 5545 §3.1: content lines SHOULD be folded at 75 octets; a continuation line starts with a single space, which itself counts toward that line's 75-octet budget. */
const FOLD_WIDTH = 75;

/** RFC 5545 §3.3.11 TEXT escaping — backslash, comma, semicolon, and any line break. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function foldIcsLine(line: string): string {
  if (line.length <= FOLD_WIDTH) return line;
  const segments: string[] = [];
  let rest = line;
  let budget = FOLD_WIDTH;
  while (rest.length > budget) {
    segments.push(rest.slice(0, budget));
    rest = rest.slice(budget);
    budget = FOLD_WIDTH - 1; // continuation lines open with a folding space
  }
  segments.push(rest);
  return segments.join(`${CRLF} `);
}

function formatIcsUtcTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Deterministic per-event UID derived only from the given inputs (no randomness), so re-downloading the same premiere's event yields byte-identical UID — the property calendar apps de-duplicate a re-imported event on. */
function buildIcsUid(input: IcsEventInput, dtstart: string): string {
  const slug =
    input.url.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "premiere";
  return `${slug}-${dtstart}@proxywar`;
}

/**
 * Builds a single-VEVENT .ics document as a CRLF-terminated string.
 * `now` is injected only so DTSTAMP is deterministic under test — every
 * other field is a pure function of `input`. Throws on an unparseable
 * `scheduledAt` rather than emitting an invalid DTSTART.
 */
export function buildIcsEvent(
  input: IcsEventInput,
  now: Date = new Date(),
): string {
  const startMs = Date.parse(input.scheduledAt);
  if (Number.isNaN(startMs)) {
    throw new Error(`invalid_scheduled_at: ${input.scheduledAt}`);
  }
  const dtstart = formatIcsUtcTimestamp(startMs);
  const dtstamp = formatIcsUtcTimestamp(now.getTime());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ProxyWar//Premiere Calendar//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${buildIcsUid(input, dtstart)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    `DESCRIPTION:${escapeIcsText(input.url)}`,
    `URL:${escapeIcsText(input.url)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join(CRLF)}${CRLF}`;
}
