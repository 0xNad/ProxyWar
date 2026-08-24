import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSpatialXpManifest,
  SPATIAL_XP_GAME_NAMES,
  SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
} from "./build-spatial-xp-manifest.mjs";
import {
  finalizeSpatialXpManifestSet,
  SPATIAL_XP_VERIFIED_AUTHORITY_STATUS,
  SPATIAL_XP_VERIFIED_UPLOAD_BLOCKED,
  type SpatialXpAuthorityEvidence,
  validateSpatialXpArmParity,
  validateVerifiedSpatialXpArmParity,
  validateVerifiedSpatialXpReceiptTransition,
} from "./finalize-spatial-xp-manifest.mjs";

const adapterRoot = process.cwd().endsWith("coworld-adapter")
  ? process.cwd()
  : resolve(process.cwd(), "coworld-adapter");
const SOURCE_SHA = "a69175a30577b3e516f09a2cb0960d4d129b3f33";
const SOURCE_TREE = "0123456789abcdef0123456789abcdef01234567";
const FETCHED_AT = "2026-08-24T04:19:51Z";
const COWORLD_CLIENT_VERSION_RAW = "0.1.42\n";
const IMAGE_TAG_REVISION = SOURCE_SHA.slice(0, 9);
const rawTemplate = readFileSync(
  resolve(adapterRoot, "coworld/coworld_manifest_template.json"),
  "utf8",
);
const canonical = JSON.parse(
  rawTemplate
    .replaceAll("{{GAME_IMAGE}}", `proxywar-spatial-xp:${IMAGE_TAG_REVISION}`)
    .replaceAll(
      "{{RUNNABLES_IMAGE}}",
      `proxywar-spatial-runnables:${IMAGE_TAG_REVISION}`,
    )
    .replaceAll(
      "{{COMMISSIONER_IMAGE}}",
      `proxywar-spatial-commissioner:${IMAGE_TAG_REVISION}`,
    )
    .replaceAll("{{SOURCE_SHA}}", SOURCE_SHA),
);
canonical.game.version = "0.1.0";

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function exactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitBlobHash(raw: string): string {
  const bytes = Buffer.from(raw, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function roleEvidence({
  role,
  localTag,
  digit,
  coworldImageID,
}: {
  role: "game" | "runnables" | "commissioner";
  localTag: string;
  digit: string;
  coworldImageID: string;
}) {
  const clientHash = `sha256:${digit.repeat(64)}`;
  const imageDigest = `sha256:${String(Number(digit) + 1).repeat(64)}`;
  const title =
    role === "game" ? "proxywar-spatial-xp" : `proxywar-spatial-${role}`;
  const repository = localTag.slice(0, localTag.lastIndexOf(":"));
  const immutableReference = `${repository}@${clientHash}`;
  const coworldRaw = exactJson({
    id: coworldImageID,
    name: title,
    version: 1,
    client_hash: clientHash,
    status: "ready",
    image_uri: null,
    image_digest: imageDigest,
    public_image_uri: null,
  });
  const inspectRaw = exactJson([
    {
      Id: clientHash,
      RepoTags: [localTag],
      RepoDigests: [immutableReference],
      Architecture: "amd64",
      Os: "linux",
      Config: {
        Labels: {
          "org.opencontainers.image.revision": SOURCE_SHA,
          "org.opencontainers.image.source":
            "https://github.com/0xNad/ProxyWar",
          "org.opencontainers.image.title": title,
        },
      },
    },
  ]);
  return {
    coworldRaw,
    coworldSha256: hash(coworldRaw),
    immutableInspectRaw: inspectRaw,
    immutableInspectSha256: hash(inspectRaw),
    inspectRaw,
    inspectSha256: hash(inspectRaw),
  };
}

function makeEvidence(blockedManifest: any): SpatialXpAuthorityEvidence {
  return {
    game: roleEvidence({
      role: "game",
      localTag: blockedManifest.game.runnable.image,
      digit: "1",
      coworldImageID: "img_11111111-1111-4111-8111-111111111111",
    }),
    runnables: roleEvidence({
      role: "runnables",
      localTag: blockedManifest.player[0].image,
      digit: "4",
      coworldImageID: "img_22222222-2222-4222-8222-222222222222",
    }),
    commissioner: roleEvidence({
      role: "commissioner",
      localTag: blockedManifest.commissioner[0].image,
      digit: "7",
      coworldImageID: "img_33333333-3333-4333-8333-333333333333",
    }),
  };
}

function authorityContext(evidence: SpatialXpAuthorityEvidence) {
  return {
    coworldClientVersionRaw: COWORLD_CLIENT_VERSION_RAW,
    coworldClientVersionSha256: hash(COWORLD_CLIENT_VERSION_RAW),
    fetchedAt: FETCHED_AT,
    requestedCoworldImageIDs: {
      game: JSON.parse(evidence.game.coworldRaw).id,
      runnables: JSON.parse(evidence.runnables.coworldRaw).id,
      commissioner: JSON.parse(evidence.commissioner.coworldRaw).id,
    },
    sourceTree: SOURCE_TREE,
    templateGitBlob: gitBlobHash(rawTemplate),
  };
}

function buildArmSet() {
  return {
    off: buildSpatialXpManifest(canonical, "off", SOURCE_SHA),
    structured: buildSpatialXpManifest(canonical, "structured", SOURCE_SHA),
    on: buildSpatialXpManifest(canonical, "on", SOURCE_SHA),
  };
}

function finalize(evidence: SpatialXpAuthorityEvidence) {
  return finalizeSpatialXpManifestSet(
    rawTemplate,
    evidence,
    SOURCE_SHA,
    authorityContext(evidence),
  );
}

function mutateCoworld(
  evidence: SpatialXpAuthorityEvidence,
  role: keyof SpatialXpAuthorityEvidence,
  mutate: (value: any) => void,
) {
  const value = JSON.parse(evidence[role].coworldRaw);
  mutate(value);
  evidence[role].coworldRaw = exactJson(value);
  evidence[role].coworldSha256 = hash(evidence[role].coworldRaw);
}

function mutateInspect(
  evidence: SpatialXpAuthorityEvidence,
  role: keyof SpatialXpAuthorityEvidence,
  mutate: (value: any) => void,
) {
  const value = JSON.parse(evidence[role].inspectRaw);
  mutate(value);
  evidence[role].inspectRaw = exactJson(value);
  evidence[role].inspectSha256 = hash(evidence[role].inspectRaw);
}

function mutateImmutableInspect(
  evidence: SpatialXpAuthorityEvidence,
  role: keyof SpatialXpAuthorityEvidence,
  mutate: (value: any) => void,
) {
  const value = JSON.parse(evidence[role].immutableInspectRaw);
  mutate(value);
  evidence[role].immutableInspectRaw = exactJson(value);
  evidence[role].immutableInspectSha256 = hash(
    evidence[role].immutableInspectRaw,
  );
}

describe("spatial XP Coworld image authority finalizer", () => {
  it("deterministically builds and finalizes all three arms from one canonical input", () => {
    const canonicalBefore = structuredClone(canonical);
    const expectedBlocked = buildArmSet();
    const result = finalize(makeEvidence(expectedBlocked.off));

    expect(canonical).toEqual(canonicalBefore);
    expect(
      validateSpatialXpArmParity(result.blockedManifests, SOURCE_SHA),
    ).toBeDefined();
    expect(() =>
      validateVerifiedSpatialXpArmParity(
        result.manifests,
        result.receipt,
        result.receiptSha256,
      ),
    ).not.toThrow();
    for (const arm of ["off", "structured", "on"] as const) {
      const blocked = result.blockedManifests[arm];
      const finalized = result.manifests[arm];
      expect(finalized.game.name).toBe(SPATIAL_XP_GAME_NAMES[arm]);
      expect(finalized.game.description).toContain(
        `IMAGE AUTHORITY VERIFIED by receipt sha256:${result.receiptSha256}`,
      );
      expect(finalized.game.description).not.toContain("UPLOAD BLOCKED");
      expect(finalized.game.docs.readme.value).toContain(
        "Coworld proves each image ID, ready status, client hash, and immutable digest",
      );
      expect(finalized.game.docs.readme.value).toContain(
        "local Docker proves linux/amd64",
      );
      const authority = finalized.game.docs.pages.find(
        (page: { id?: string }) =>
          page.id === SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
      );
      expect(authority.title).toBe("Spatial XP image authority receipt");
      expect(authority.content.value).toContain(
        `status=${SPATIAL_XP_VERIFIED_AUTHORITY_STATUS}`,
      );
      expect(authority.content.value).toContain(
        `upload_blocked=${String(SPATIAL_XP_VERIFIED_UPLOAD_BLOCKED)}`,
      );
      expect(authority.content.value).toContain(
        "authority_split=coworld:id_status_client_hash_image_digest;local_docker:platform_revision_tag",
      );

      const normalizedBefore = structuredClone(blocked);
      const normalizedAfter = structuredClone(finalized);
      normalizedAfter.game.runnable.image =
        normalizedBefore.game.runnable.image;
      for (const key of ["player", "optimizer", "commissioner"] as const) {
        for (const [index, entry] of normalizedAfter[key].entries()) {
          entry.image = normalizedBefore[key][index].image;
        }
      }
      for (const candidate of [normalizedBefore, normalizedAfter]) {
        candidate.game.description = "NORMALIZED";
        candidate.game.docs.readme.value = "NORMALIZED";
        const page = candidate.game.docs.pages.find(
          (entry: { id?: string }) =>
            entry.id === SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
        );
        page.title = "NORMALIZED";
        page.content.value = "NORMALIZED";
      }
      expect(normalizedAfter).toEqual(normalizedBefore);
    }
    expect(result.receiptRaw).toBe(
      `${JSON.stringify(result.receipt, null, 2)}\n`,
    );
    expect(hash(result.receiptRaw)).toBe(result.receiptSha256);
    expect(result.receipt.sourceTree).toBe(SOURCE_TREE);
    expect(result.receipt.manifestAuthority.templateGitBlob).toBe(
      gitBlobHash(rawTemplate),
    );
    expect(result.receipt.manifestAuthority.templateSha256).toBe(
      hash(rawTemplate),
    );
    expect(result.receipt.manifestAuthority.renderedCanonicalSha256).toBe(
      hash(exactJson(canonical)),
    );
    expect(result.receipt.manifestAuthority.imageTagRevision).toBe(
      IMAGE_TAG_REVISION,
    );
    for (const arm of ["off", "structured", "on"] as const) {
      expect(result.receipt.manifestAuthority.blockedManifestSha256[arm]).toBe(
        hash(result.blockedManifestRaw[arm]),
      );
    }
    expect(result.receipt.generatedFrom.sourceCheckout).toMatchObject({
      revision: SOURCE_SHA,
      tree: SOURCE_TREE,
      trackedStatus: "clean",
    });
    expect(result.receipt.images[0]!.localDockerID).toBe(
      result.receipt.images[0]!.coworldClientHash,
    );
    expect(result.receipt.images[0]!.coworldImageDigest).not.toBe(
      result.receipt.images[0]!.coworldClientHash,
    );
    expect(result.receipt.images[0]!.coworldFetchCommand).toEqual([
      "uvx",
      "--from",
      "coworld==0.1.42",
      "coworld",
      "images",
      result.receipt.images[0]!.coworldImageID,
      "--json",
    ]);
    expect(result.receipt.images[0]!.immutableLocalReference).toBe(
      `proxywar-spatial-xp@${result.receipt.images[0]!.localDockerID}`,
    );
    for (const arm of ["off", "structured", "on"] as const) {
      expect(result.manifests[arm].game.runnable.image).toBe(
        result.receipt.images[0]!.immutableLocalReference,
      );
      expect(result.manifests[arm].player[0].image).toBe(
        result.receipt.images[1]!.immutableLocalReference,
      );
      expect(result.manifests[arm].optimizer[0].image).toBe(
        result.receipt.images[1]!.immutableLocalReference,
      );
      expect(result.manifests[arm].commissioner[0].image).toBe(
        result.receipt.images[2]!.immutableLocalReference,
      );
    }
  });

  it("rejects raw byte substitution before parsing semantically identical JSON", () => {
    const evidence = makeEvidence(buildArmSet().off);
    evidence.game.coworldRaw = evidence.game.coworldRaw.replace(
      "\n  ",
      "\n   ",
    );
    expect(() => finalize(evidence)).toThrow(
      "game Coworld response SHA-256 mismatch",
    );
  });

  it.each([
    [
      "non-ready Coworld image",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateCoworld(evidence, "game", (value) => {
          value.status = "pending";
        }),
      "authority response is not ready and exact",
    ],
    [
      "wrong Coworld image name",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateCoworld(evidence, "game", (value) => {
          value.name = "proxywar-spatial-runnables";
        }),
      "authority response is not ready and exact",
    ],
    [
      "unexpected Coworld field",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateCoworld(evidence, "runnables", (value) => {
          value.claimed_revision = SOURCE_SHA;
        }),
      "fields do not match the authority schema",
    ],
    [
      "Coworld/local client-hash mismatch",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateCoworld(evidence, "commissioner", (value) => {
          value.client_hash = `sha256:${"f".repeat(64)}`;
        }),
      "local Docker id does not match Coworld client hash",
    ],
    [
      "arm64 local image",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateInspect(evidence, "game", (value) => {
          value[0].Architecture = "arm64";
        }),
      "source/platform/tag join failed",
    ],
    [
      "stale OCI revision",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateInspect(evidence, "runnables", (value) => {
          value[0].Config.Labels["org.opencontainers.image.revision"] =
            "e".repeat(40);
        }),
      "source/platform/tag join failed",
    ],
    [
      "wrong local tag",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateInspect(evidence, "commissioner", (value) => {
          value[0].RepoTags = ["wrong:tag"];
        }),
      "source/platform/tag join failed",
    ],
    [
      "immutable digest reference resolves to another image",
      (evidence: SpatialXpAuthorityEvidence) =>
        mutateImmutableInspect(evidence, "game", (value) => {
          value[0].Id = `sha256:${"f".repeat(64)}`;
        }),
      "immutable Docker reference does not resolve to the verified id",
    ],
    [
      "duplicate Coworld image id",
      (evidence: SpatialXpAuthorityEvidence) => {
        const gameID = JSON.parse(evidence.game.coworldRaw).id;
        mutateCoworld(evidence, "commissioner", (value) => {
          value.id = gameID;
        });
      },
      "image ids must be unique",
    ],
  ])("fails closed for %s", (_label, mutate, message) => {
    const evidence = makeEvidence(buildArmSet().off);
    mutate(evidence);
    expect(() => finalize(evidence)).toThrow(message);
  });

  it.each([
    ["off", { PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1" }],
    ["structured", {}],
    [
      "structured",
      {
        PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
        PROXYWAR_TUNE_SPATIAL_MINIMAP: "1",
      },
    ],
    ["on", { PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1" }],
    [
      "on",
      {
        PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
        PROXYWAR_TUNE_SPATIAL_MINIMAP: "true",
      },
    ],
  ] as const)("rejects wrong %s arm environment %#", (arm, spatialEnv) => {
    const armSet = buildArmSet();
    const drifted = armSet[arm];
    for (const key of [
      "PROXYWAR_TUNE_SPATIAL_OBSERVATION",
      "PROXYWAR_TUNE_SPATIAL_MINIMAP",
    ]) {
      delete drifted.game.runnable.env[key];
    }
    Object.assign(drifted.game.runnable.env, spatialEnv);
    expect(() => validateSpatialXpArmParity(armSet, SOURCE_SHA)).toThrow(
      "manifest spatial arm environment is not exact",
    );
  });

  it.each([
    [
      "unrelated environment",
      (armSet: ReturnType<typeof buildArmSet>) => {
        armSet.structured.game.runnable.env.PROXYWAR_TUNE_FREETEXT_MESSAGES =
          "0";
      },
    ],
    [
      "variant",
      (armSet: ReturnType<typeof buildArmSet>) => {
        armSet.structured.variants = [];
      },
    ],
    [
      "protocol",
      (armSet: ReturnType<typeof buildArmSet>) => {
        armSet.structured.game.protocols.player.value += " drift";
      },
    ],
    [
      "result schema",
      (armSet: ReturnType<typeof buildArmSet>) => {
        armSet.structured.game.results_schema = { drift: true };
      },
    ],
    [
      "certification",
      (armSet: ReturnType<typeof buildArmSet>) => {
        armSet.structured.certification = { drift: true };
      },
    ],
    [
      "runnable image",
      (armSet: ReturnType<typeof buildArmSet>) => {
        armSet.structured.player[0].image = "other-runnables:latest";
      },
    ],
  ])("rejects one-arm %s drift", (_label, mutate) => {
    const armSet = buildArmSet();
    mutate(armSet);
    expect(() => validateSpatialXpArmParity(armSet, SOURCE_SHA)).toThrow(
      "differs from OFF outside the exact spatial treatment",
    );
  });

  it("rejects caller-altered canonical template bytes against the clean Git blob", () => {
    const evidence = makeEvidence(buildArmSet().off);
    const context = authorityContext(evidence);
    const alteredTemplate = rawTemplate.replace(
      '"PROXYWAR_TUNE_FREETEXT_MESSAGES": "1"',
      '"PROXYWAR_TUNE_FREETEXT_MESSAGES": "0"',
    );
    expect(alteredTemplate).not.toBe(rawTemplate);
    expect(() =>
      finalizeSpatialXpManifestSet(
        alteredTemplate,
        evidence,
        SOURCE_SHA,
        context,
      ),
    ).toThrow(
      "canonical template bytes do not match the clean checkout Git blob",
    );
  });

  it("pins finalized manifests to digest references and rejects a mutable-tag reintroduction", () => {
    const result = finalize(makeEvidence(buildArmSet().off));
    const mutableTag = result.blockedManifests.on.game.runnable.image;
    const immutableReference = result.manifests.on.game.runnable.image;
    expect(mutableTag).toMatch(/:[0-9a-f]{9}$/u);
    expect(immutableReference).toMatch(/@sha256:[0-9a-f]{64}$/u);
    expect(immutableReference).not.toBe(mutableTag);

    const retagged = structuredClone(result.manifests);
    retagged.on.game.runnable.image = mutableTag;
    expect(() =>
      validateVerifiedSpatialXpArmParity(
        retagged,
        result.receipt,
        result.receiptSha256,
      ),
    ).toThrow("verified manifest game image is not immutable and exact");
  });

  it("rejects matched edits to every verified arm against the receipted blocked inputs", () => {
    const result = finalize(makeEvidence(buildArmSet().off));
    const drifted = structuredClone(result.manifests);
    for (const manifest of Object.values(drifted)) {
      manifest.game.runnable.env.PROXYWAR_TUNE_FREETEXT_MESSAGES = "0";
    }
    expect(() =>
      validateVerifiedSpatialXpReceiptTransition(
        result.blockedManifests,
        drifted,
        result.receipt,
        result.receiptSha256,
      ),
    ).toThrow(
      "off verified manifest is not the deterministic receipt transition",
    );
  });

  it("binds each raw Coworld response to the exact requested image id", () => {
    const evidence = makeEvidence(buildArmSet().off);
    const context = authorityContext(evidence);
    context.requestedCoworldImageIDs.game =
      "img_99999999-9999-4999-8999-999999999999";
    expect(() =>
      finalizeSpatialXpManifestSet(rawTemplate, evidence, SOURCE_SHA, context),
    ).toThrow("game Coworld response id does not match the request");
  });

  it("rejects edited hard-stop markers in any arm", () => {
    const editedGate = buildArmSet();
    editedGate.off.game.description = editedGate.off.game.description.replace(
      "UPLOAD BLOCKED",
      "UPLOAD MAYBE BLOCKED",
    );
    expect(() => validateSpatialXpArmParity(editedGate, SOURCE_SHA)).toThrow(
      "description is not exactly upload-blocked",
    );

    const editedPage = buildArmSet();
    editedPage.on.game.docs.pages.find(
      (page: { id?: string }) => page.id === SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
    ).content.value = "status=verified\nupload_blocked=false";
    expect(() => validateSpatialXpArmParity(editedPage, SOURCE_SHA)).toThrow(
      "authority gate is not the exact hard stop",
    );
  });
});
