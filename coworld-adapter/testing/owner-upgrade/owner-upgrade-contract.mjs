export const PUBLIC_BASE = "190ea95eda41fbf5d1521d433b3365d87b9cfe57";
export const EXISTING_FILES = [
  "Dockerfile",
  "MESSAGES.md",
  "ONBOARDING.md",
  "README.md",
  "llm-player.mjs",
  "package.json",
  "starter-player.mjs",
];
export const NEW_FILES = [
  "owner-capabilities.d.mts",
  "owner-capabilities.mjs",
  "owner-capability-contract.test.mjs",
  "owner-evidence-check.mjs",
  "owner-evidence-check.test.mjs",
  "owner-player-frame.test.mjs",
];
export const FILES = [...EXISTING_FILES, ...NEW_FILES].sort();

function exactLayerMap(lines, layer, expectedFiles) {
  const entries = lines.filter((entry) => entry.layer === layer);
  if (entries.length !== expectedFiles.length) {
    throw new Error(`${layer} ledger cardinality mismatch`);
  }
  const byFile = new Map();
  for (const entry of entries) {
    if (byFile.has(entry.file)) {
      throw new Error(`duplicate ${layer} ledger entry for ${entry.file}`);
    }
    byFile.set(entry.file, entry.digest);
  }
  if (
    JSON.stringify([...byFile.keys()].sort()) !==
    JSON.stringify([...expectedFiles].sort())
  ) {
    throw new Error(`${layer} ledger file set mismatch`);
  }
  return byFile;
}

export function parseOwnerUpgradeLedger(raw) {
  if (typeof raw !== "string" || !raw.endsWith("\n") || raw.includes("\r")) {
    throw new Error("sealed ledger must be LF text with one terminal newline");
  }
  const rawLines = raw.slice(0, -1).split("\n");
  if (rawLines.some((line) => line.length === 0)) {
    throw new Error("sealed ledger must not contain blank lines");
  }
  const lines = rawLines.map((line) => {
    const match =
      /^(meta|packet|base|expected|source-blob) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Za-z0-9._/-]+)$/u.exec(
        line,
      );
    if (match === null)
      throw new Error(`malformed sealed ledger line: ${line}`);
    const [, layer, digest, file] = match;
    const expectedDigestLength =
      layer === "meta" || layer === "source-blob" ? 40 : 64;
    if (digest.length !== expectedDigestLength) {
      throw new Error(`wrong digest width in sealed ledger line: ${line}`);
    }
    return { layer, digest, file };
  });
  const meta = exactLayerMap(lines, "meta", [
    "public-base",
    "candidate-source",
    "candidate-tree",
  ]);
  const packetEntries = exactLayerMap(lines, "packet", [
    "proxywar-owner-upgrade.patch",
  ]);
  const baseEntries = exactLayerMap(lines, "base", EXISTING_FILES);
  const expectedEntries = exactLayerMap(lines, "expected", FILES);
  const sourceBlobs = exactLayerMap(lines, "source-blob", FILES);
  if (meta.get("public-base") !== PUBLIC_BASE) {
    throw new Error("sealed ledger public base mismatch");
  }
  const candidateSource = meta.get("candidate-source");
  const candidateTree = meta.get("candidate-tree");
  if (
    !/^[0-9a-f]{40}$/u.test(candidateSource ?? "") ||
    !/^[0-9a-f]{40}$/u.test(candidateTree ?? "")
  ) {
    throw new Error("sealed ledger candidate source is missing or malformed");
  }
  return {
    baseEntries,
    candidateSource,
    candidateTree,
    expectedEntries,
    patchDigest: packetEntries.get("proxywar-owner-upgrade.patch"),
    sourceBlobs,
  };
}
