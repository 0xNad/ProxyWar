import fs from "fs/promises";
import { execFileSync } from "child_process";
import path from "path";
import { describe, expect, it } from "vitest";

describe("ProxyWar hosted beta smoke script", () => {
  it("queues the same bounded saved-roster request as the public tester UI", async () => {
    const script = await fs.readFile(
      path.join(process.cwd(), "src", "scripts", "proxywar-hosted-beta-smoke.ts"),
      "utf8",
    );

    expect(script).toContain("proxyWarTesterSavedRosterJobDefaults");
    expect(script).toContain("12-round saved-roster match");
    expect(script).not.toContain('roster: "default"');
    expect(script).not.toContain("maxSteps: 2");
    expect(script).not.toContain("nations: 2");
  });

  it("prints missing configuration as a clean blocked report", async () => {
    const root = process.cwd();
    const tsx = path.join(root, "node_modules", ".bin", "tsx");
    const script = path.join(
      root,
      "src",
      "scripts",
      "proxywar-hosted-beta-smoke.ts",
    );
    let output = "";
    let status: number | undefined;

    try {
      execFileSync(tsx, [script], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PROXYWAR_PUBLIC_URL: "",
          PROXYWAR_BETA_CODE: "",
          PROXYWAR_BETA_PASSWORD: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      status = failed.status;
      output = `${failed.stdout?.toString() ?? ""}${failed.stderr?.toString() ?? ""}`;
    }

    expect(status).toBe(1);
    expect(output).toContain("ProxyWar hosted beta smoke: blocked");
    expect(output).toContain("Set PROXYWAR_PUBLIC_URL");
    expect(output).not.toContain("at parseArgs");
    expect(output).not.toContain("Node.js v");
  });
});
