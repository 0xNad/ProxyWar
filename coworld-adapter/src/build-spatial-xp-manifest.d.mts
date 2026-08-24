export type SpatialXpArm = "off" | "structured" | "on";

export const SPATIAL_XP_GAME_NAMES: Readonly<Record<SpatialXpArm, string>>;
export const SPATIAL_XP_VISIBILITY_MODEL: string;
export const SPATIAL_XP_STRUCTURED_ENV: Readonly<Record<string, string>>;
export const SPATIAL_XP_ENV: Readonly<Record<string, string>>;
export const SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID: string;
export const SPATIAL_XP_IMAGE_AUTHORITY_STATUS: "unverified";
export const SPATIAL_XP_UPLOAD_BLOCKED: true;
export const SPATIAL_XP_PROTOCOL_APPENDIX: string;

export function buildSpatialXpManifest<T extends object>(
  canonicalManifest: T,
  arm: SpatialXpArm,
  expectedSourceSha: string,
): T;
