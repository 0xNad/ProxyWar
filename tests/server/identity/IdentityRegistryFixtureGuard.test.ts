/**
 * Stage 8 item 1's "production never renders fixture identities" guard:
 * `resolveIdentityRegistryDir` (`IdentityRegistry.ts`) always falls back to
 * the tracked `resources/identity/` directory unless
 * `PROXYWAR_IDENTITY_REGISTRY_DIR` is explicitly set — and nothing under
 * `deploy/` (every real launch script/env template/launchd plist this repo
 * ships) ever sets it. Together these two facts are the whole guard: a
 * real deployment has no way to reach fixture data short of an operator
 * manually exporting the override, which this test would also catch if a
 * future deploy file ever added it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  IDENTITY_REGISTRY_DIR_ENV,
  resolveIdentityRegistryDir,
} from "../../../src/server/identity/IdentityRegistry";

const REPO_ROOT = path.resolve(__dirname, "../../..");

async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFilesRecursively(fullPath);
      return [fullPath];
    }),
  );
  return files.flat();
}

describe("resolveIdentityRegistryDir", () => {
  test("defaults to the tracked resources/identity directory when unset", () => {
    expect(resolveIdentityRegistryDir({}, "/repo")).toBe(
      path.join("/repo", "resources", "identity"),
    );
  });

  test("defaults to the tracked directory when the env var is an empty string", () => {
    expect(
      resolveIdentityRegistryDir({ [IDENTITY_REGISTRY_DIR_ENV]: "" }, "/repo"),
    ).toBe(path.join("/repo", "resources", "identity"));
  });

  test("resolves an explicit override to an absolute path (fixture command only)", () => {
    expect(
      resolveIdentityRegistryDir(
        { [IDENTITY_REGISTRY_DIR_ENV]: "/fixtures/identity" },
        "/repo",
      ),
    ).toBe("/fixtures/identity");
  });

  test("resolves a relative override against the given cwd", () => {
    expect(
      resolveIdentityRegistryDir(
        { [IDENTITY_REGISTRY_DIR_ENV]: "relative/identity" },
        "/repo",
      ),
    ).toBe(path.resolve("/repo", "relative/identity"));
  });

  test("is unaffected by unrelated env vars (e.g. PROXYWAR_ARTIFACTS_ROOT, which production DOES set)", () => {
    expect(
      resolveIdentityRegistryDir(
        { PROXYWAR_ARTIFACTS_ROOT: "/deploy/artifacts" },
        "/repo",
      ),
    ).toBe(path.join("/repo", "resources", "identity"));
  });
});

describe("production guard: no deploy file ever sets PROXYWAR_IDENTITY_REGISTRY_DIR", () => {
  test("deploy/ (every real launch script, env template, and launchd plist) never references the override", async () => {
    const deployDir = path.join(REPO_ROOT, "deploy");
    const files = await listFilesRecursively(deployDir);
    expect(files.length).toBeGreaterThan(0); // sanity: the scan actually found files
    const offenders: string[] = [];
    for (const file of files) {
      const contents = await fs.readFile(file, "utf8").catch(() => "");
      if (contents.includes(IDENTITY_REGISTRY_DIR_ENV)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no tracked resources/identity/*.json entry carries a fixture- slug (the fixture generator's own naming convention)", async () => {
    const identityDir = path.join(REPO_ROOT, "resources", "identity");
    for (const fileName of ["agents.json", "builders.json", "versions.json"]) {
      const filePath = path.join(identityDir, fileName);
      const raw = await fs.readFile(filePath, "utf8").catch(() => null);
      if (raw === null) continue; // registry file not present in this checkout
      expect(raw).not.toContain('"fixture-');
      expect(raw).not.toContain("agt_fixture-");
      expect(raw).not.toContain("bld_fixture-");
    }
  });
});
