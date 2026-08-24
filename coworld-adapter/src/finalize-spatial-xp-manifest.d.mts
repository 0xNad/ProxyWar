export const SPATIAL_XP_VERIFIED_AUTHORITY_STATUS: "verified";
export const SPATIAL_XP_VERIFIED_UPLOAD_BLOCKED: false;

export function renderCanonicalManifest<T extends object = Record<string, any>>(
  templateRaw: string,
  expectedSourceSha: string,
): {
  imageTagRevision: string;
  manifest: T;
  raw: string;
};

export interface SpatialXpAuthorityRoleEvidence {
  coworldRaw: string;
  coworldSha256: string;
  immutableInspectRaw: string;
  immutableInspectSha256: string;
  inspectRaw: string;
  inspectSha256: string;
}

export interface SpatialXpAuthorityEvidence {
  game: SpatialXpAuthorityRoleEvidence;
  runnables: SpatialXpAuthorityRoleEvidence;
  commissioner: SpatialXpAuthorityRoleEvidence;
}

export interface SpatialXpAuthorityContext {
  coworldClientVersionRaw: string;
  coworldClientVersionSha256: string;
  fetchedAt: string;
  requestedCoworldImageIDs: {
    game: string;
    runnables: string;
    commissioner: string;
  };
  sourceTree: string;
  templateGitBlob: string;
}

export interface SpatialXpAuthorityReceiptImage {
  role: "game" | "runnables" | "commissioner";
  localTag: string;
  platform: "linux/amd64";
  ociRevision: string;
  localDockerID: string;
  immutableLocalReference: string;
  coworldImageID: string;
  coworldFetchCommand: string[];
  coworldName: string;
  coworldVersion: number;
  coworldStatus: "ready";
  coworldClientHash: string;
  coworldImageDigest: string;
  coworldResponseSha256: string;
  coworldResponseArtifact: string;
  localInspectSha256: string;
  localInspectArtifact: string;
  localInspectCommand: string[];
  immutableInspectSha256: string;
  immutableInspectArtifact: string;
  immutableInspectCommand: string[];
}

export interface SpatialXpAuthorityReceipt {
  schemaVersion: "proxywar-spatial-verified-image-receipt-v1";
  generatedFrom: {
    coworldAuthority: string;
    localAuthority: string;
    join: string;
    coworldClient: {
      package: "coworld";
      version: string;
      versionCommand: string[];
      versionResponseArtifact: "coworld-client-version.txt";
      versionResponseSha256: string;
    };
    sourceCheckout: {
      revision: string;
      tree: string;
      trackedStatus: "clean";
      revisionCommand: string[];
      treeCommand: string[];
      statusCommand: string[];
      templateBlobCommand: string[];
    };
  };
  fetchedAt: string;
  sourceSha: string;
  sourceTree: string;
  manifestAuthority: {
    templatePath: string;
    templateGitBlob: string;
    templateSha256: string;
    renderedCanonicalSha256: string;
    imageTagRevision: string;
    causalContract: string;
    blockedManifestSha256: Record<"off" | "structured" | "on", string>;
  };
  canonicalPackageOrLeagueMutation: false;
  images: SpatialXpAuthorityReceiptImage[];
}

export type SpatialXpManifestSet<T extends object> = Record<
  "off" | "structured" | "on",
  T
>;

export interface FinalizedSpatialXpManifestSet<T extends object> {
  blockedManifests: SpatialXpManifestSet<T>;
  blockedManifestRaw: Record<"off" | "structured" | "on", string>;
  canonicalManifest: T;
  canonicalManifestRaw: string;
  manifests: SpatialXpManifestSet<T>;
  receipt: SpatialXpAuthorityReceipt;
  receiptRaw: string;
  receiptSha256: string;
}

export function validateSpatialXpArmParity<T extends object>(
  manifests: SpatialXpManifestSet<T>,
  expectedSourceSha: string,
): object;

export function validateVerifiedSpatialXpArmParity<T extends object>(
  manifests: SpatialXpManifestSet<T>,
  receipt: SpatialXpAuthorityReceipt,
  receiptSha256: string,
): void;

export function deriveVerifiedSpatialXpManifestSet<T extends object>(
  blockedManifests: SpatialXpManifestSet<T>,
  receipt: SpatialXpAuthorityReceipt,
  receiptSha256: string,
): SpatialXpManifestSet<T>;

export function validateVerifiedSpatialXpReceiptTransition<T extends object>(
  blockedManifests: SpatialXpManifestSet<T>,
  manifests: SpatialXpManifestSet<T>,
  receipt: SpatialXpAuthorityReceipt,
  receiptSha256: string,
): SpatialXpManifestSet<T>;

export function finalizeSpatialXpManifestSet<
  T extends object = Record<string, any>,
>(
  canonicalTemplateRaw: string,
  evidence: SpatialXpAuthorityEvidence,
  expectedSourceSha: string,
  authorityContext: SpatialXpAuthorityContext,
): FinalizedSpatialXpManifestSet<T>;
