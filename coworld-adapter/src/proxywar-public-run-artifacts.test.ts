import { describe, expect, it } from "vitest";
import { proxyWarPublicRunArtifacts } from "../../src/server/agents/ProxyWarPublicArtifacts";
import { coworldPublicRunArtifacts } from "./proxywar-public-run-artifacts.ts";

describe("Coworld public run artifacts", () => {
  it("is a privacy-safe subset of the canonical public contract", () => {
    for (const artifact of coworldPublicRunArtifacts) {
      expect(proxyWarPublicRunArtifacts).toContain(artifact);
    }
    expect(coworldPublicRunArtifacts).toContain("deal-ledger.json");
    expect(coworldPublicRunArtifacts).not.toContain("decisions.jsonl");
    expect(coworldPublicRunArtifacts).not.toContain("visual-report.html");
  });
});
