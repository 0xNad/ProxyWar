import { createHash } from "node:crypto";

import JSZip from "jszip";

const EXPECTED_MEMBER_PATHS = [
  "logs/game.log",
  "manifest.json",
  "replay",
  "results.json",
] as const;

export interface CommanderXpParsedEpisodeBundle {
  manifest: Record<string, unknown>;
  memberHashes: {
    schemaVersion: 2;
    episodeRequestID: string;
    include: ["results", "replay", "game_logs"];
    outerZipSha256: string;
    members: Array<{ path: string; size: number; sha256: string }>;
  };
  resultsText: string;
  replayBytes: Uint8Array;
  gameLogText: string;
}

export async function parseCommanderXpEpisodeBundleBytes(
  outerBytes: Uint8Array,
  episodeRequestID: string,
): Promise<CommanderXpParsedEpisodeBundle> {
  if (outerBytes.byteLength === 0 || outerBytes.byteLength > 512 * 1024 * 1024) {
    throw new Error("episode bundle byte length is invalid");
  }
  const zip = await JSZip.loadAsync(outerBytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files);
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some(
      (entry) =>
        entry.dir ||
        entry.name.startsWith("/") ||
        entry.name.includes("\\") ||
        entry.name.split("/").includes(".."),
    ) ||
    JSON.stringify(names) !== JSON.stringify(EXPECTED_MEMBER_PATHS)
  ) {
    throw new Error("episode bundle entry allowlist mismatch");
  }
  const bytesByPath = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength > 256 * 1024 * 1024) {
      throw new Error("episode bundle member exceeds bounded limit");
    }
    bytesByPath.set(entry.name, bytes);
  }
  const decode = (name: string): string =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytesByPath.get(name)!);
  const manifest = JSON.parse(decode("manifest.json")) as Record<
    string,
    unknown
  >;
  if (
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(["ereq_id", "files", "include", "status"]) ||
    manifest.ereq_id !== episodeRequestID ||
    manifest.status !== "success" ||
    JSON.stringify(manifest.include) !==
      JSON.stringify(["results", "replay", "game_logs"]) ||
    JSON.stringify(manifest.files) !==
      JSON.stringify({
        results: "results.json",
        replay: "replay",
        game_logs: { combined: "logs/game.log" },
      })
  ) {
    throw new Error("episode bundle manifest mismatch");
  }
  const members = EXPECTED_MEMBER_PATHS.map((memberPath) => {
    const bytes = bytesByPath.get(memberPath)!;
    return {
      path: memberPath,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
  return {
    manifest,
    memberHashes: {
      schemaVersion: 2,
      episodeRequestID,
      include: ["results", "replay", "game_logs"],
      outerZipSha256: sha256(outerBytes),
      members,
    },
    resultsText: decode("results.json"),
    replayBytes: bytesByPath.get("replay")!,
    gameLogText: decode("logs/game.log"),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
