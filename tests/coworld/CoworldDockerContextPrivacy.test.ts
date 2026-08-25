import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Coworld Docker context privacy", () => {
  it("excludes the prohibited proprietary tree at both selection layers", async () => {
    const source = await fs.readFile(
      path.join(
        process.cwd(),
        "coworld-adapter/scripts/prepare-docker-context.mjs",
      ),
      "utf8",
    );

    const entryList = source.match(
      /const proxyWarEntries = \[([\s\S]*?)\n\];/,
    )?.[1];

    expect(entryList).toBeDefined();
    expect(entryList).not.toContain('"proprietary"');
    expect(source).toContain('name === "proprietary"');
    expect(source).toContain('    "proprietary",\n    ".env",');
  });
});
