import { z } from "zod";
import { GameRecord, GameRecordSchema } from "../core/Schemas";

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
  })
  .passthrough();

export interface CoworldStaticReplay {
  runID: string;
  gameRecord: GameRecord;
  sourceUrl: string;
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

  return {
    runID: envelope.data.runID,
    gameRecord: gameRecord.data,
    sourceUrl,
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
