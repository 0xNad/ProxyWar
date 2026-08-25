import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Commander starter is an example beside the canonical builder path", () => {
  const root = process.cwd();
  const starter = path.join(root, "coworld-adapter", "commander-starter");

  it("ships a complete pinned public starter contract", async () => {
    const required = [
      "Dockerfile",
      "README.md",
      "launch.sh",
      "commander-player.ts",
      "commander-production-runtime.ts",
      "package.json",
      "package-lock.json",
      "starter-contract.node.mjs",
      "LICENSE",
    ];
    await Promise.all(
      required.map((file) => fs.access(path.join(starter, file))),
    );
  });

  it("pins hosted tooling and stamps the exact source revision into the image", async () => {
    const [launch, dockerfile, packageJsonText, lockText] = await Promise.all([
      fs.readFile(path.join(starter, "launch.sh"), "utf8"),
      fs.readFile(path.join(starter, "Dockerfile"), "utf8"),
      fs.readFile(path.join(starter, "package.json"), "utf8"),
      fs.readFile(path.join(starter, "package-lock.json"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      name: string;
      version: string;
    };
    const lock = JSON.parse(lockText) as {
      lockfileVersion: number;
      packages: Record<string, { name?: string; version?: string }>;
    };

    expect(dockerfile).toMatch(/^FROM [^\s]+@sha256:[a-f0-9]{64}$/m);
    expect(dockerfile).toContain(
      'org.opencontainers.image.revision="${STARTER_SOURCE_SHA}"',
    );
    expect(launch).toContain('COWORLD_PACKAGE="coworld==0.1.42"');
    expect(launch).toContain('SOFTMAX_CLI_PACKAGE="softmax-cli==0.26.30"');
    expect(launch).toContain('--build-arg "STARTER_SOURCE_SHA=$SOURCE_SHA"');
    expect(launch).toContain("status --porcelain --untracked-files=all -- .");
    expect(launch).not.toMatch(/curl[^\n|]*\|\s*(?:sh|bash)/);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
    });
  });

  it("keeps the Build page and league-mirror entry link on the canonical Coworld starter", async () => {
    const [buildPage, mirror] = await Promise.all([
      fs.readFile(path.join(root, "src/client/publicapp/BuildPage.ts"), "utf8"),
      fs.readFile(
        path.join(root, "src/scripts/coworld-league-mirror.ts"),
        "utf8",
      ),
    ]);
    expect(buildPage).toContain(
      "https://github.com/0xNad/proxywar-coworld-starter.git",
    );
    expect(buildPage).not.toContain("proxywar-commander-starter");
    expect(mirror).toContain(
      "https://github.com/0xNad/proxywar-coworld-starter",
    );
    expect(mirror).not.toContain("proxywar-commander-starter");
  });
});
