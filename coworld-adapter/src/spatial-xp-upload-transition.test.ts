import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSpatialXpManifest } from "./build-spatial-xp-manifest.mjs";
import type { SpatialXpAuthorityReceipt } from "./finalize-spatial-xp-manifest.mjs";
import { renderCanonicalManifest } from "./finalize-spatial-xp-manifest.mjs";
import {
  captureExactCommand,
  expectedStoredManifest,
  validateCanonicalUploadInputs,
  validateProductionState,
  validateStoredCoworldUpload,
  validateUploadAuthorityReceipt,
} from "./spatial-xp-upload-transition.mjs";

const SOURCE_SHA = "a69175a30577b3e516f09a2cb0960d4d129b3f33";
const SOURCE_TREE = "0123456789abcdef0123456789abcdef01234567";
const RECEIPT_HASH = "f".repeat(64);
const ADAPTER_ROOT = process.cwd().endsWith("coworld-adapter")
  ? process.cwd()
  : resolve(process.cwd(), "coworld-adapter");
const TEMPLATE_RAW = readFileSync(
  resolve(ADAPTER_ROOT, "coworld/coworld_manifest_template.json"),
  "utf8",
);
const ROLE_DATA = [
  {
    role: "game",
    name: "proxywar-spatial-xp",
    id: "img_11111111-1111-4111-8111-111111111111",
    digit: "1",
  },
  {
    role: "runnables",
    name: "proxywar-spatial-runnables",
    id: "img_22222222-2222-4222-8222-222222222222",
    digit: "2",
  },
  {
    role: "commissioner",
    name: "proxywar-spatial-commissioner",
    id: "img_33333333-3333-4333-8333-333333333333",
    digit: "3",
  },
] as const;

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function receipt(): SpatialXpAuthorityReceipt {
  return {
    schemaVersion: "proxywar-spatial-verified-image-receipt-v1",
    generatedFrom: {
      coworldAuthority: "Coworld API",
      localAuthority: "Docker inspect",
      join: "Docker Id == Coworld client_hash",
      coworldClient: {
        package: "coworld",
        version: "0.1.42",
        versionCommand: [],
        versionResponseArtifact: "coworld-client-version.txt",
        versionResponseSha256: "a".repeat(64),
      },
      sourceCheckout: {
        revision: SOURCE_SHA,
        tree: SOURCE_TREE,
        trackedStatus: "clean",
        revisionCommand: [],
        treeCommand: [],
        statusCommand: [],
        templateBlobCommand: [],
      },
    },
    fetchedAt: "2026-08-24T05:00:00Z",
    sourceSha: SOURCE_SHA,
    sourceTree: SOURCE_TREE,
    manifestAuthority: {
      templatePath: "coworld-adapter/coworld/coworld_manifest_template.json",
      templateGitBlob: "a".repeat(40),
      templateSha256: "b".repeat(64),
      renderedCanonicalSha256: "c".repeat(64),
      imageTagRevision: SOURCE_SHA.slice(0, 9),
      causalContract: "exact",
      blockedManifestSha256: {
        off: "d".repeat(64),
        structured: "e".repeat(64),
        on: "f".repeat(64),
      },
    },
    canonicalPackageOrLeagueMutation: false,
    images: ROLE_DATA.map(({ role, name, id, digit }) => {
      const dockerID = `sha256:${digit.repeat(64)}`;
      return {
        role,
        localTag: `${name}:${SOURCE_SHA.slice(0, 9)}`,
        platform: "linux/amd64" as const,
        ociRevision: SOURCE_SHA,
        localDockerID: dockerID,
        immutableLocalReference: `${name}@${dockerID}`,
        coworldImageID: id,
        coworldFetchCommand: [],
        coworldName: name,
        coworldVersion: 1,
        coworldStatus: "ready" as const,
        coworldClientHash: dockerID,
        coworldImageDigest: `sha256:${String(Number(digit) + 4).repeat(64)}`,
        coworldResponseSha256: "6".repeat(64),
        coworldResponseArtifact: `${role}-coworld-image.json`,
        localInspectSha256: "7".repeat(64),
        localInspectArtifact: `${role}-docker-inspect.json`,
        localInspectCommand: [],
        immutableInspectSha256: "8".repeat(64),
        immutableInspectArtifact: `${role}-docker-immutable-inspect.json`,
        immutableInspectCommand: [],
      };
    }),
  };
}

function verifiedManifest(authorityReceipt = receipt()) {
  const byRole = Object.fromEntries(
    authorityReceipt.images.map((image) => [
      image.role,
      image.immutableLocalReference,
    ]),
  );
  return {
    game: {
      name: "proxywar-spatial-xp-off",
      version: "0.1.0",
      description: `IMAGE AUTHORITY VERIFIED by receipt sha256:${RECEIPT_HASH}`,
      runnable: { type: "game", image: byRole.game, env: {} },
      replay_viewer: { bundle: "build/static-replay-viewer" },
    },
    player: [{ type: "player", image: byRole.runnables }],
    reporter: [{ type: "reporter", image: byRole.runnables }],
    optimizer: [{ type: "optimizer", image: byRole.runnables }],
    commissioner: [{ type: "commissioner", image: byRole.commissioner }],
  };
}

function storedPackage(
  manifest = verifiedManifest(),
  authorityReceipt = receipt(),
) {
  return {
    id: "cow_11111111-1111-4111-8111-111111111111",
    name: "proxywar-spatial-xp-off",
    version: "0.1.0",
    manifest: {
      ...expectedStoredManifest(manifest, authorityReceipt),
      game: {
        ...expectedStoredManifest(manifest, authorityReceipt).game,
        replay_viewer: { bundle: `sha256:${"9".repeat(64)}` },
      },
    },
    manifest_hash: `sha256:${"a".repeat(64)}`,
    size_bytes: 1,
    canonical: false,
  };
}

function canonicalInputs(authorityReceipt = receipt()) {
  const canonical = renderCanonicalManifest(TEMPLATE_RAW, SOURCE_SHA);
  const blockedRaw = Object.fromEntries(
    (["off", "structured", "on"] as const).map((arm) => [
      arm,
      `${JSON.stringify(
        buildSpatialXpManifest(canonical.manifest, arm, SOURCE_SHA),
        null,
        2,
      )}\n`,
    ]),
  ) as Record<"off" | "structured" | "on", string>;
  authorityReceipt.manifestAuthority.templateSha256 = hash(TEMPLATE_RAW);
  authorityReceipt.manifestAuthority.renderedCanonicalSha256 = hash(
    canonical.raw,
  );
  for (const arm of ["off", "structured", "on"] as const) {
    authorityReceipt.manifestAuthority.blockedManifestSha256[arm] = hash(
      blockedRaw[arm],
    );
  }
  return { blockedRaw, canonical, receipt: authorityReceipt };
}

describe("spatial XP immutable upload transition", () => {
  it("runs certification helpers from the explicit canonical cwd and preserves stderr", () => {
    const capture = captureExactCommand(
      process.execPath,
      [
        "-e",
        'process.stdout.write(process.cwd()); process.stderr.write("diagnostic")',
      ],
      "cwd probe",
      1024,
      process.env,
      ADAPTER_ROOT,
    );
    expect(capture.status).toBe(0);
    expect(capture.raw).toBe(ADAPTER_ROOT);
    expect(capture.stderrRaw).toBe("diagnostic");
  });

  it("accepts an exact receipt and maps digest references to exact Coworld ids", () => {
    const authorityReceipt = receipt();
    const manifest = verifiedManifest(authorityReceipt);
    expect(
      validateUploadAuthorityReceipt(authorityReceipt, SOURCE_SHA, SOURCE_TREE),
    ).toBe("0.1.42");
    const expected = expectedStoredManifest(manifest, authorityReceipt);
    expect(expected.game.runnable.image).toBe(
      authorityReceipt.images[0].coworldImageID,
    );
    expect(expected.player[0].image).toBe(
      authorityReceipt.images[1].coworldImageID,
    );
    expect(expected.commissioner[0].image).toBe(
      authorityReceipt.images[2].coworldImageID,
    );
    const storedCommissioner = expected.commissioner[0] as {
      env?: Record<string, string>;
      run?: string[];
    };
    expect(storedCommissioner.env).toEqual({});
    expect(storedCommissioner.run).toEqual([]);

    const stored = storedPackage(manifest, authorityReceipt);
    expect(() =>
      validateStoredCoworldUpload(
        stored,
        {
          id: stored.id,
          manifest_hash: stored.manifest_hash,
        },
        manifest,
        authorityReceipt,
        "off",
      ),
    ).not.toThrow();
  });

  it("accepts only Coworld's exact empty commissioner storage defaults", () => {
    const authorityReceipt = receipt();
    const manifest = verifiedManifest(authorityReceipt);
    const stored = storedPackage(manifest, authorityReceipt);
    const storedCommissioner = stored.manifest.commissioner[0] as {
      env?: Record<string, string>;
      run?: string[];
    };

    storedCommissioner.env = { UNRECEIPTED: "1" };
    expect(() =>
      validateStoredCoworldUpload(
        stored,
        { id: stored.id, manifest_hash: stored.manifest_hash },
        manifest,
        authorityReceipt,
        "off",
      ),
    ).toThrow(/does not match the verified upload/u);

    storedCommissioner.env = {};
    storedCommissioner.run = ["unexpected"];
    expect(() =>
      validateStoredCoworldUpload(
        stored,
        { id: stored.id, manifest_hash: stored.manifest_hash },
        manifest,
        authorityReceipt,
        "off",
      ),
    ).toThrow(/does not match the verified upload/u);
  });

  it("rejects reintroduced mutable tags before package upload", () => {
    const authorityReceipt = receipt();
    const manifest = verifiedManifest(authorityReceipt);
    manifest.game.runnable.image = authorityReceipt.images[0].localTag;
    expect(() => expectedStoredManifest(manifest, authorityReceipt)).toThrow(
      /image absent from receipt/u,
    );
  });

  it("independently derives canonical and blocked bytes instead of trusting a fabricated receipt", () => {
    const exact = canonicalInputs();
    expect(() =>
      validateCanonicalUploadInputs(
        TEMPLATE_RAW,
        exact.canonical.raw,
        exact.blockedRaw,
        exact.receipt,
        SOURCE_SHA,
      ),
    ).not.toThrow();

    const driftedRaw = structuredClone(exact.blockedRaw);
    for (const arm of ["off", "structured", "on"] as const) {
      const drifted = JSON.parse(driftedRaw[arm]);
      drifted.game.runnable.env.PROXYWAR_TUNE_FREETEXT_MESSAGES = "0";
      driftedRaw[arm] = `${JSON.stringify(drifted, null, 2)}\n`;
      exact.receipt.manifestAuthority.blockedManifestSha256[arm] = hash(
        driftedRaw[arm],
      );
    }
    expect(() =>
      validateCanonicalUploadInputs(
        TEMPLATE_RAW,
        exact.canonical.raw,
        driftedRaw,
        exact.receipt,
        SOURCE_SHA,
      ),
    ).toThrow(/not the exact canonical derivative/u);
  });

  it("rejects a receipt whose immutable reference no longer binds its Docker id", () => {
    const authorityReceipt = receipt();
    authorityReceipt.images[0].immutableLocalReference = `proxywar-spatial-xp@sha256:${"9".repeat(64)}`;
    expect(() =>
      validateUploadAuthorityReceipt(authorityReceipt, SOURCE_SHA, SOURCE_TREE),
    ).toThrow(/game image identity is malformed/u);
  });

  it("rejects a stored package that substitutes any unreceipted image id", () => {
    const authorityReceipt = receipt();
    const manifest = verifiedManifest(authorityReceipt);
    const stored = storedPackage(manifest, authorityReceipt);
    stored.manifest.game.runnable.image =
      "img_99999999-9999-4999-8999-999999999999";
    expect(() =>
      validateStoredCoworldUpload(
        stored,
        { id: stored.id, manifest_hash: stored.manifest_hash },
        manifest,
        authorityReceipt,
        "off",
      ),
    ).toThrow(/does not match the verified upload/u);
  });

  it("requires the exact canonical package and paused production league binding", () => {
    const coworld = {
      id: "cow_f58621db-4a09-47de-bb13-24d61050a837",
      name: "proxywar",
      version: "0.1.54",
      manifest_hash:
        "sha256:42e0d2e81685b495f663e7ce965f06de1a8f5d86af177cf72e67577753dfc304",
      canonical: true,
    };
    const league = {
      id: "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42",
      game: {
        coworld_id: coworld.id,
        canonical_coworld_id: coworld.id,
      },
      rounds_paused_at: "2026-08-22T12:17:45.774392Z",
    };
    expect(() => validateProductionState(coworld, league)).not.toThrow();

    league.game.coworld_id = "cow_99999999-9999-4999-8999-999999999999";
    expect(() => validateProductionState(coworld, league)).toThrow(
      /paused league binding is not exact/u,
    );
  });
});
