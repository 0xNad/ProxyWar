import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURED_MATCH_STATE_ROOT_ENV } from "../../../../src/server/agents/FeaturedMatch";
import {
  EVENT_PACKAGE_STATE_ROOT_ENV,
  EventPackageSchema,
  findEventPackage,
  readEventPackageStore,
  resolveEventPackageStateRoot,
  upsertEventPackage,
  writeEventPackageStore,
  type EventPackage,
} from "../../../../src/server/agents/season/EventPackage";

function basePackage(overrides: Partial<EventPackage> = {}): EventPackage {
  return {
    schemaVersion: 1,
    featuredMatchId: `feat_${"a".repeat(20)}`,
    title: "Auri vs Sefirot",
    subtitle: "Pangaea — 2p duel",
    reasonToWatch: { claims: [] },
    mapLabel: "Pangaea",
    format: "2p duel",
    scheduledAt: "2026-08-08T18:00:00.000Z",
    canonicalMatchUrl: `/match/feat_${"a".repeat(20)}`,
    canonicalPremiereUrl: "/premiere/abc123",
    embargoState: "embargoed",
    editorialNotes: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("EventPackageSchema", () => {
  it("accepts a valid package", () => {
    expect(() => EventPackageSchema.parse(basePackage())).not.toThrow();
  });

  it("rejects an unknown featuredMatchId shape", () => {
    expect(() =>
      EventPackageSchema.parse(
        basePackage({ featuredMatchId: "not-a-feat-id" }),
      ),
    ).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() =>
      EventPackageSchema.parse(basePackage({ title: "" })),
    ).toThrow();
  });

  it("accepts a legacy directorCutEstimateSeconds field (pre-removal persisted record) and strips it from the parsed output", () => {
    const legacyRecord = { ...basePackage(), directorCutEstimateSeconds: 300 };
    const parsed = EventPackageSchema.parse(legacyRecord);
    expect(parsed).not.toHaveProperty("directorCutEstimateSeconds");
    expect(parsed.title).toBe(legacyRecord.title);
  });

  it("rejects an unrelated unknown key — only the retired directorCutEstimateSeconds field is tolerated", () => {
    expect(() =>
      EventPackageSchema.parse({ ...basePackage(), someUnknownField: "x" }),
    ).toThrow();
  });
});

describe("resolveEventPackageStateRoot", () => {
  it("falls back to the FeaturedMatch state root when unset", () => {
    const environment = { HOME: "/home/op" };
    const resolved = resolveEventPackageStateRoot(environment, "/home/op");
    expect(resolved).toContain(path.join("storage", "featured-matches"));
  });

  it("honors its own override independently of FeaturedMatch's root", () => {
    const environment = {
      [EVENT_PACKAGE_STATE_ROOT_ENV]: "/custom/event-packages",
      [FEATURED_MATCH_STATE_ROOT_ENV]: "/custom/featured-matches",
    };
    expect(resolveEventPackageStateRoot(environment, "/home/op")).toBe(
      "/custom/event-packages",
    );
  });
});

describe("EventPackage store (atomic read/write)", () => {
  let stateRoot: string;

  afterEach(async () => {
    if (stateRoot !== undefined)
      await rm(stateRoot, { recursive: true, force: true });
  });

  it("returns an empty store on a cold start", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "event-package-store-"));
    const store = await readEventPackageStore(stateRoot);
    expect(store).toEqual({ schemaVersion: 1, packages: [] });
  });

  it("round-trips a written package", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "event-package-store-"));
    await writeEventPackageStore(stateRoot, {
      schemaVersion: 1,
      packages: [basePackage()],
    });
    const reloaded = await readEventPackageStore(stateRoot);
    expect(reloaded.packages).toHaveLength(1);
  });

  it("upsertEventPackage replaces an existing package by featuredMatchId rather than duplicating", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "event-package-store-"));
    await upsertEventPackage(stateRoot, basePackage({ title: "First draft" }));
    await upsertEventPackage(stateRoot, basePackage({ title: "Second draft" }));
    const store = await readEventPackageStore(stateRoot);
    expect(store.packages).toHaveLength(1);
    expect(store.packages[0]!.title).toBe("Second draft");
  });

  it("throws loudly on a corrupt store file", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "event-package-store-"));
    await writeFile(
      path.join(stateRoot, "event-packages.json"),
      "{not json",
      "utf8",
    );
    await expect(readEventPackageStore(stateRoot)).rejects.toThrow();
  });
});

describe("findEventPackage", () => {
  it("finds a package by featuredMatchId", () => {
    const pkg = basePackage();
    const store = { schemaVersion: 1 as const, packages: [pkg] };
    expect(findEventPackage(store, pkg.featuredMatchId)).toEqual(pkg);
  });

  it("returns null when no package exists for the id", () => {
    const store = { schemaVersion: 1 as const, packages: [] };
    expect(findEventPackage(store, "feat_missing")).toBeNull();
  });
});
