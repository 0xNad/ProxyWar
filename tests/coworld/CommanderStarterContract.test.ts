import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Commander starter is the default builder path", () => {
  const root = process.cwd();
  const starter = path.join(root, "coworld-adapter", "commander-starter");

  it("ships a complete pinned public starter contract", async () => {
    const required = [
      "Dockerfile",
      "README.md",
      "launch.sh",
      "package.json",
      "starter-contract.test.mjs",
      "LICENSE",
    ];
    await Promise.all(
      required.map((file) => fs.access(path.join(starter, file))),
    );
  });

  it("is the recommended Build page and league-mirror link", async () => {
    const [buildPage, mirror] = await Promise.all([
      fs.readFile(path.join(root, "src/client/publicapp/BuildPage.ts"), "utf8"),
      fs.readFile(
        path.join(root, "src/scripts/coworld-league-mirror.ts"),
        "utf8",
      ),
    ]);
    expect(buildPage).toContain(
      "https://github.com/0xNad/proxywar-commander-starter.git",
    );
    expect(mirror).toContain(
      "https://github.com/0xNad/proxywar-commander-starter",
    );
  });
});
