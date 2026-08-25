import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Coworld commissioner supply chain", () => {
  const root = path.join(process.cwd(), "coworld-adapter", "commissioner");

  it("uses digest-pinned runtime and installer images", async () => {
    const dockerfile = await fs.readFile(path.join(root, "Dockerfile"), "utf8");
    const fromLines = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("FROM "));
    expect(fromLines).toHaveLength(2);
    for (const line of fromLines) {
      expect(line).toMatch(/@sha256:[a-f0-9]{64}(?:\s+AS\s+\w+)?$/);
    }
  });

  it("installs only from the committed frozen lock", async () => {
    const [dockerfile, lock] = await Promise.all([
      fs.readFile(path.join(root, "Dockerfile"), "utf8"),
      fs.readFile(path.join(root, "uv.lock"), "utf8"),
    ]);
    expect(lock).toContain('name = "commissioners"');
    expect(dockerfile).toContain("COPY pyproject.toml uv.lock README.md /app/");
    expect(dockerfile).toContain("RUN uv sync --frozen --no-dev --no-editable");
    expect(dockerfile).not.toMatch(/\bpip install\b/);
  });
});
