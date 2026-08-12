// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("ProxyWar optimizer runnable", () => {
  it("executes from its shipped script and writes the advisory plan", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "proxywar-optimizer-plan-"),
    );
    const output = path.join(directory, "plan.json");
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(here, "proxywar-optimizer-plan.mjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            COGAME_OPTIMIZER_OUTPUT_URI: output,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        optimizer_id: "proxywar-optimizer-plan",
        input_counts: { diagnoses: 0, reports: 0, grades: 0 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
