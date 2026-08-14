import { z } from "zod";
import { GameRecord, GameRecordSchema } from "../core/Schemas";
import { publishSpectatorReplay } from "./SpectatorReplayStore";

const CoworldStaticReplayEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    replayKind: z.literal("proxywar-coworld-local-poc"),
    runID: z.string().min(1),
    inlineRunArtifacts: z
      .object({
        "game-record.json": z.string().min(1),
      })
      .passthrough(),
    // Deliberately untyped: the capture side owns this shape and the consumer
    // (SpectatorReplayStore) validates it defensively — a malformed or absent
    // spectatorReplay means "no territory graph", never a failed parse.
    spectatorReplay: z.unknown().optional(),
    // The run's own decision-integrity block. Same treatment: unknown here,
    // shape-walked by ReplayIntegrityStore, absent simply means the broadcast
    // says nothing about integrity rather than reporting zeroes.
    results: z.unknown().optional(),
  })
  .passthrough();

export interface CoworldStaticReplay {
  runID: string;
  gameRecord: GameRecord;
  sourceUrl: string;
  /**
   * Broadcast artifacts carried INLINE in the replay envelope.
   *
   * The overlay normally hydrates these over the network from
   * `/ai-league-runs/<runID>/...`, but a static bundle has no artifact server —
   * so that fetch could never succeed and the War Room sat on "No notable
   * events yet." for the whole match while the envelope was carrying 1,138
   * scored, timestamped events the entire time.
   *
   * Optional by design: an older or trimmed envelope may omit them, and the
   * board must still play. Absent → the feed stays quiet, never broken.
   */
  spectatorTelemetry: unknown | null;
  matchSummary: unknown | null;
  /**
   * The envelope's periodic whole-board territory samples
   * (`spectatorReplay.snapshots`), retained for the scrubber's territory-race
   * graph. This used to be parsed and then DROPPED by the return statement
   * below — the passthrough schema kept it alive through validation and the
   * cherry-pick lost it. Untyped on purpose: SpectatorReplayStore owns the
   * defensive shape-walk; absent or malformed simply means "no graph".
   */
  spectatorReplay: unknown | null;
  /**
   * The envelope's `results` block — the run's own tallies, including
   * decision_count / accepted_decision_count / fallback_count / degraded_count.
   *
   * This was being validated and then dropped by the cherry-picking return
   * below, the same way spectatorReplay once was. On the reference fixture it
   * says 1,262 decisions with 583 fallbacks and 525 degraded: nearly half the
   * match did not come from the agents, which is the single most consequential
   * fact about whether the premise of an agent tournament held. See
   * ReplayIntegrityStore for why this source is preferred over the
   * match-summary artifact, which disagrees with it.
   */
  runResults: unknown | null;
}

/** Parse an optional inline artifact without failing the whole replay. */
function optionalInlineJson(
  artifacts: Record<string, unknown>,
  key: string,
): unknown | null {
  const raw = artifacts[key];
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed side artifact must not take the board down with it.
    return null;
  }
}

export function isCoworldStaticReplayViewer(): boolean {
  return window.__PROXYWAR_STATIC_REPLAY__ === true;
}

export function coworldStaticReplayUrl(
  search = window.location.search,
): string {
  const replayUrl = new URLSearchParams(search).get("replay")?.trim();
  if (!replayUrl) {
    throw new Error("Missing required replay URL in the ?replay= parameter");
  }
  return replayUrl;
}

export function parseCoworldStaticReplay(
  bytes: ArrayBuffer | Uint8Array,
  sourceUrl = "replay",
): CoworldStaticReplay {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(decoded);
  } catch (error) {
    throw new Error("Coworld replay is not valid UTF-8 JSON", { cause: error });
  }

  const envelope = CoworldStaticReplayEnvelopeSchema.safeParse(envelopeValue);
  if (!envelope.success) {
    throw new Error("Coworld replay envelope failed schema validation", {
      cause: envelope.error,
    });
  }

  let gameRecordValue: unknown;
  try {
    gameRecordValue = JSON.parse(
      envelope.data.inlineRunArtifacts["game-record.json"],
    );
  } catch (error) {
    throw new Error("Embedded game-record.json is not valid JSON", {
      cause: error,
    });
  }

  const gameRecord = GameRecordSchema.safeParse(gameRecordValue);
  if (!gameRecord.success) {
    throw new Error("Embedded game-record.json failed schema validation", {
      cause: gameRecord.error,
    });
  }

  const artifacts = envelope.data.inlineRunArtifacts as Record<string, unknown>;

  // Publish the territory samples to the module-level store from INSIDE the
  // parser: this parser only ever runs on the static-bundle path, so the
  // store is populated exactly when the broadcast surface exists — no Main.ts
  // wiring, no plumbing through the return value's consumers. Publishing
  // `undefined` (older/trimmed envelope) clears the store rather than letting
  // a previous match's series bleed into this one.
  const spectatorReplay = envelope.data.spectatorReplay ?? null;
  publishSpectatorReplay(spectatorReplay);

  return {
    runID: envelope.data.runID,
    gameRecord: gameRecord.data,
    sourceUrl,
    spectatorTelemetry: optionalInlineJson(artifacts, "spectator-telemetry.json"),
    matchSummary: optionalInlineJson(artifacts, "match-summary.json"),
    spectatorReplay,
    runResults: envelope.data.results ?? null,
  };
}

export async function loadCoworldStaticReplay(
  options: {
    search?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<CoworldStaticReplay> {
  const sourceUrl = coworldStaticReplayUrl(options.search);
  const response = await (options.fetchImpl ?? fetch)(sourceUrl, {
    cache: "no-store",
    credentials: "omit",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Coworld replay returned HTTP ${response.status}`);
  }
  return parseCoworldStaticReplay(await response.arrayBuffer(), sourceUrl);
}

declare global {
  interface Window {
    __PROXYWAR_STATIC_REPLAY__?: boolean;
  }
}
