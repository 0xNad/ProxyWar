import { describe, expect, it } from "vitest";
import { buildIcsEvent } from "../../../src/client/publicapp/Ics";

/** Minimal RFC 5545 unfolder + property parser — enough to round-trip what `buildIcsEvent` emits, without pulling in a full ics library. */
function parseIcs(ics: string): Record<string, string> {
  const unfolded = ics.replace(/\r\n /g, "");
  const lines = unfolded.split("\r\n").filter((line) => line.length > 0);
  const props: Record<string, string> = {};
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    props[key] = value;
  }
  return props;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

describe("buildIcsEvent", () => {
  it("produces a valid VCALENDAR/VEVENT structure", () => {
    const ics = buildIcsEvent({
      title: "Proxy War Premiere — Round 12 (Ashfields)",
      scheduledAt: "2026-08-15T14:30:00.000Z",
      url: "https://example.test/premiere/prem_1",
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    const veventStart = ics.indexOf("BEGIN:VEVENT");
    const veventEnd = ics.indexOf("END:VEVENT");
    expect(veventStart).toBeGreaterThan(-1);
    expect(veventEnd).toBeGreaterThan(veventStart);
  });

  it("formats DTSTART as a UTC YYYYMMDDTHHMMSSZ timestamp", () => {
    const ics = buildIcsEvent({
      title: "Round 3",
      scheduledAt: "2026-01-05T09:07:03.000Z",
      url: "https://example.test/premiere/prem_2",
    });
    const props = parseIcs(ics);
    expect(props.DTSTART).toBe("20260105T090703Z");
  });

  it("uses the injected `now` for a deterministic DTSTAMP", () => {
    const ics = buildIcsEvent(
      {
        title: "Round 1",
        scheduledAt: "2026-08-15T14:30:00.000Z",
        url: "https://example.test/premiere/prem_3",
      },
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const props = parseIcs(ics);
    expect(props.DTSTAMP).toBe("20260801T000000Z");
  });

  it("escapes commas, semicolons, and newlines in SUMMARY per RFC 5545 — never emitted raw", () => {
    const ics = buildIcsEvent({
      title: 'Round, 12; "Ashfields"\nSpecial map',
      scheduledAt: "2026-08-15T14:30:00.000Z",
      url: "https://example.test/premiere/prem_4",
    });
    const props = parseIcs(ics);
    expect(props.SUMMARY).toBe('Round\\, 12\\; "Ashfields"\\nSpecial map');
    // The raw comma/semicolon/newline must never appear unescaped in the property value.
    expect(props.SUMMARY).not.toMatch(/(?<!\\)[,;]/);
    expect(props.SUMMARY).not.toContain("\n");
  });

  it("round-trips SUMMARY and DTSTART through a basic manual parse", () => {
    const title = "Round, seven; the rematch";
    const ics = buildIcsEvent({
      title,
      scheduledAt: "2026-09-01T12:00:00.000Z",
      url: "https://example.test/premiere/prem_5",
    });
    const props = parseIcs(ics);
    expect(unescapeIcsText(props.SUMMARY)).toBe(title);
    expect(props.DTSTART).toBe("20260901T120000Z");
    expect(unescapeIcsText(props.DESCRIPTION)).toBe(
      "https://example.test/premiere/prem_5",
    );
  });

  it("folds long content lines at 75 octets with a single leading space, and unfolds back to the original value", () => {
    const longTitle = "A".repeat(200);
    const ics = buildIcsEvent({
      title: longTitle,
      scheduledAt: "2026-08-15T14:30:00.000Z",
      url: "https://example.test/premiere/prem_6",
    });
    // At least one folded continuation line (CRLF + a single space) exists.
    expect(ics).toMatch(/\r\n [^\r\n]/);
    const props = parseIcs(ics);
    expect(props.SUMMARY).toBe(longTitle);
    // No raw content line (pre-unfold) exceeds the 75-octet budget.
    for (const line of ics.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
  });

  it("derives a deterministic UID from the same inputs — no randomness", () => {
    const input = {
      title: "Round 4",
      scheduledAt: "2026-08-15T14:30:00.000Z",
      url: "https://example.test/premiere/prem_7",
    };
    const first = parseIcs(buildIcsEvent(input, new Date(0))).UID;
    const second = parseIcs(buildIcsEvent(input, new Date(1_000_000))).UID;
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it("throws on an unparseable scheduledAt rather than emitting an invalid DTSTART", () => {
    expect(() =>
      buildIcsEvent({
        title: "Round 1",
        scheduledAt: "not-a-date",
        url: "https://example.test/premiere/prem_8",
      }),
    ).toThrow(/invalid_scheduled_at/);
  });
});
