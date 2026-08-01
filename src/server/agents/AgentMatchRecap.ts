import fs from "fs/promises";
import path from "path";
import {
  FINAL_CONFLICT_TURN_CAP,
  FINAL_CONFLICT_TURN_FRACTION,
} from "./DirectorCutPlan";
import type { SpectatorEvent, SpectatorTelemetry } from "./AgentSpectatorTelemetry";

/**
 * Event-derived match recap: the public match page's "what actually
 * happened" section. Deliberately NOT `AgentMatchStory`'s diagnostic prose
 * (entertainment score, boringness warnings, profile-differentiation
 * gate) — that generator's `summary`/`spectatorHighlights` are QA
 * telemetry for match-design tuning, not a battle story (a 2026-08-01
 * review confirmed shipping it as "the recap" gave production pages
 * generic diagnostics: "N story-worthy decisions... grade X/100" and
 * aggregate action counts, never a fact about who did what to whom).
 *
 * Instead this reuses the EXACT curated-event vocabulary the client's
 * "War Room" feed already surfaces (`curatedWarRoomEvents` in
 * `AiLeagueReplayOverlay.ts`, `pushWarRoomEvent` in
 * `ReplayPremiereRuntime.ts`) — alliance formation, first strike (first
 * attack per ordered actor/target pair only, never every attack),
 * betrayal (an active alliance break), and elimination — plus one
 * addition only meaningful post-hoc (a live/streaming overlay can't see
 * ahead): a "final confrontation" beat when the endgame window contains a
 * genuine attack/nuke event, using the SAME endgame window
 * `DirectorCutPlan.ts`'s own `final_conflict` segment uses
 * (`FINAL_CONFLICT_TURN_FRACTION`/`FINAL_CONFLICT_TURN_CAP`, imported, not
 * duplicated). `lead_change` is deliberately never produced here either —
 * see `curatedWarRoomEvents`'s own doc: no turn-by-turn territory series
 * is available from decision-record telemetry, so a lead-change beat
 * would have to fabricate a moment. Every beat message is either the
 * `SpectatorEvent.message` the telemetry builder already generated (a
 * factual, already-vetted sentence — see `AgentSpectatorTelemetry.ts`'s
 * `eventForRecord`) or a small factual template built only from
 * `actorName`/`targetName`, never an inferred or embellished claim.
 *
 * `buildAgentMatchRecap` returns `null` when the curated pass finds zero
 * beats — a genuinely quiet match, never padded with a placeholder
 * sentence (same "never a fabricated placeholder" rule
 * `LeagueEpisodeMatchPage.ts`'s `LeagueEpisodeRecap` doc already states).
 */

export interface AgentMatchRecapBeat {
  turnNumber: number;
  kind: "alliance" | "first_strike" | "betrayal" | "elimination" | "final_confrontation";
  message: string;
}

export interface AgentMatchRecap {
  schemaVersion: 1;
  runID: string;
  generatedAt: string;
  summary: string;
  beats: AgentMatchRecapBeat[];
}

export interface AgentMatchRecapPaths {
  jsonPath: string;
}

export interface AgentMatchRecapInput {
  runID: string;
  telemetry: SpectatorTelemetry;
  /** Authoritative turn count when known (`match-summary.json`'s `finalState.turnCount`), else `null` to fall back to the telemetry's own max event turn — same fallback `DirectorCutPlan.ts`'s `resolveTotalTurns` uses. */
  finalTurnCount: number | null;
}

const BEAT_KIND_LABEL: Record<AgentMatchRecapBeat["kind"], string> = {
  alliance: "alliance",
  first_strike: "first strike",
  betrayal: "betrayal",
  elimination: "elimination",
  final_confrontation: "final clash",
};

/** Curates the War Room vocabulary (alliance/first-strike/betrayal/elimination) from an ordered event stream — same kind-mapping `curatedWarRoomEvents` (client) applies, ported server-side. Also returns the source `SpectatorEvent.id`s it consumed, so `finalConfrontationBeat` never double-reports an attack already covered as a first strike. */
function curateWarRoomBeats(events: readonly SpectatorEvent[]): {
  beats: AgentMatchRecapBeat[];
  includedEventIds: Set<string>;
} {
  const beats: AgentMatchRecapBeat[] = [];
  const includedEventIds = new Set<string>();
  const firstStrikeSeen = new Set<string>();
  for (const event of events) {
    if (event.kind === "attack" && event.targetAgentID !== null) {
      const key = `${event.actorAgentID}|${event.targetAgentID}`;
      if (!firstStrikeSeen.has(key)) {
        firstStrikeSeen.add(key);
        includedEventIds.add(event.id);
        beats.push({
          turnNumber: event.turnNumber,
          kind: "first_strike",
          message: `${event.actorName} strikes first against ${event.targetName}.`,
        });
      }
      continue;
    }
    if (event.kind === "alliance_formed" && event.targetAgentID !== null) {
      includedEventIds.add(event.id);
      beats.push({
        turnNumber: event.turnNumber,
        kind: "alliance",
        message: event.message,
      });
      continue;
    }
    if (
      event.kind === "alliance_break" &&
      event.tone === "betrayal" &&
      event.targetAgentID !== null
    ) {
      includedEventIds.add(event.id);
      beats.push({
        turnNumber: event.turnNumber,
        kind: "betrayal",
        message: event.message,
      });
      continue;
    }
    if (event.kind === "elimination") {
      includedEventIds.add(event.id);
      beats.push({
        turnNumber: event.turnNumber,
        kind: "elimination",
        message: event.message,
      });
    }
  }
  return { beats, includedEventIds };
}

/** One beat for the highest-importance attack/nuke event inside the SAME endgame window `DirectorCutPlan.ts`'s `final_conflict` segment covers — omitted (never fabricated) when no such event exists in that window, e.g. a match that ends on a turn cap with no late fighting. */
function finalConfrontationBeat(
  events: readonly SpectatorEvent[],
  totalTurns: number,
  alreadyIncluded: ReadonlySet<string>,
): AgentMatchRecapBeat | null {
  if (totalTurns <= 0) return null;
  const windowStart = Math.max(
    0,
    totalTurns -
      Math.min(
        totalTurns,
        Math.max(1, Math.round(totalTurns * FINAL_CONFLICT_TURN_FRACTION)),
        FINAL_CONFLICT_TURN_CAP,
      ),
  );
  const candidates = events.filter(
    (event) =>
      event.turnNumber >= windowStart &&
      event.targetAgentID !== null &&
      (event.kind === "attack" || event.kind === "nuke") &&
      !alreadyIncluded.has(event.id),
  );
  if (candidates.length === 0) return null;
  const top = candidates.reduce((best, event) =>
    event.importance > best.importance ? event : best,
  );
  return {
    turnNumber: top.turnNumber,
    kind: "final_confrontation",
    message: `Final clash: ${top.message}`,
  };
}

function buildSummary(beats: readonly AgentMatchRecapBeat[]): string {
  const counts = new Map<AgentMatchRecapBeat["kind"], number>();
  for (const beat of beats) {
    counts.set(beat.kind, (counts.get(beat.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const kind of [
    "alliance",
    "betrayal",
    "first_strike",
    "elimination",
    "final_confrontation",
  ] as const) {
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;
    const label = BEAT_KIND_LABEL[kind];
    parts.push(count === 1 ? `1 ${label}` : `${count} ${label}s`);
  }
  if (parts.length === 0) return "";
  if (parts.length === 1) return `This match featured ${parts[0]}.`;
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return `This match featured ${rest.join(", ")} and ${last}.`;
}

/** `null` when the curated pass finds zero beats — see the module doc's "never padded" rule. */
export function buildAgentMatchRecap(
  input: AgentMatchRecapInput,
): AgentMatchRecap | null {
  const orderedEvents = [...input.telemetry.events].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  const { beats, includedEventIds } = curateWarRoomBeats(orderedEvents);
  const totalTurns =
    input.finalTurnCount !== null && input.finalTurnCount > 0
      ? input.finalTurnCount
      : orderedEvents.reduce((max, event) => Math.max(max, event.turnNumber), 0);
  const finalBeat = finalConfrontationBeat(
    orderedEvents,
    totalTurns,
    includedEventIds,
  );
  if (finalBeat !== null) {
    beats.push(finalBeat);
  }
  if (beats.length === 0) {
    return null;
  }
  beats.sort((a, b) => a.turnNumber - b.turnNumber);
  return {
    schemaVersion: 1,
    runID: input.runID,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(beats),
    beats,
  };
}

export async function writeAgentMatchRecapArtifacts(input: {
  recap: AgentMatchRecap;
  directory: string;
}): Promise<AgentMatchRecapPaths> {
  const jsonPath = path.join(input.directory, "match-recap.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.recap, null, 2)}\n`);
  return { jsonPath };
}
