import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public app-shell product copy", () => {
  it.each(["index.html", "public.html"])(
    "%s ships the current product title and 40-minute cadence",
    async (file) => {
      const source = await fs.readFile(path.join(process.cwd(), file), "utf8");

      expect(source).toContain(
        '<title data-i18n="main.title">Proxy War</title>',
      );
      expect(source).toContain("A new league round every 40 minutes");
      expect(source).not.toContain("A new league round every 25 minutes");
      expect(source).not.toContain("Proxy War (ALPHA)");
      expect(source).not.toContain("every 30 minutes");
    },
  );

  it("mounts and serves the privacy, terms, and credits routes", async () => {
    const [client, server, footer] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "src/client/PublicApp.ts"), "utf8"),
      fs.readFile(
        path.join(process.cwd(), "src/scripts/ai-agent-demo-server.ts"),
        "utf8",
      ),
      fs.readFile(
        path.join(process.cwd(), "src/client/publicapp/AppShellChrome.ts"),
        "utf8",
      ),
    ]);

    for (const route of ["privacy", "terms", "credits"]) {
      expect(client).toContain(`pathname === "/${route}"`);
      expect(server).toContain(
        'for (const legalRoute of ["privacy", "terms", "credits"] as const)',
      );
      expect(footer).toContain(`href="/${route}"`);
    }
  });

  it("does not promise an unmaintained weekly Featured Event cadence", async () => {
    const seasons = await fs.readFile(
      path.join(process.cwd(), "resources/season/seasons.json"),
      "utf8",
    );
    expect(seasons).toContain("selected Featured Events when scheduled");
    expect(seasons).not.toContain("weekly Featured Events");
  });
});
