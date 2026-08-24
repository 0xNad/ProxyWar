import type { SpatialXpAuthorityReceipt } from "./finalize-spatial-xp-manifest.mjs";

export interface ExactCommandCapture {
  raw: string;
  sha256: string;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderrRaw: string;
  stderrSha256: string;
}

export function captureExactCommand(
  command: string,
  args: string[],
  label: string,
  maximumBytes?: number,
  environment?: NodeJS.ProcessEnv,
  workingDirectory?: string,
): ExactCommandCapture;

export function expectedStoredManifest<T extends object>(
  manifest: T,
  receipt: SpatialXpAuthorityReceipt,
): T;

export function normalizedStoredManifest<T extends object>(manifest: T): T;

export function validateUploadAuthorityReceipt(
  receipt: SpatialXpAuthorityReceipt,
  head: string,
  tree: string,
): string;

export function validateCanonicalUploadInputs<T extends object>(
  templateRaw: string,
  canonicalRaw: string,
  blockedManifestRaw: Record<"off" | "structured" | "on", string>,
  receipt: SpatialXpAuthorityReceipt,
  head: string,
): {
  blockedManifests: Record<"off" | "structured" | "on", T>;
  canonicalManifest: T;
};

export function validateStoredCoworldUpload<T extends object>(
  storedCoworld: Record<string, any>,
  uploadResult: Record<string, any>,
  manifest: T,
  receipt: SpatialXpAuthorityReceipt,
  arm: "off" | "structured" | "on",
): void;

export function validateProductionState(
  coworldResponse: Record<string, any>,
  leagueResponse: Record<string, any>,
): void;
