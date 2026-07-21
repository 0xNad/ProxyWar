import fs from "fs/promises";
import vm from "node:vm";
import os from "os";
import path from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearAppShellContentCache,
  getAppShellContent,
  renderHtmlContent,
  setAppShellCacheHeaders,
} from "../../src/server/RenderHtml";

describe("RenderHtml", () => {
  const originalGitCommit = process.env.GIT_COMMIT;
  let tempDir: string | null = null;

  afterEach(async () => {
    process.env.GIT_COMMIT = originalGitCommit;
    clearAppShellContentCache();

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("reuses cached app shell content", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "render-html-"));
    const htmlPath = path.join(tempDir, "index.html");
    await fs.writeFile(
      htmlPath,
      "<script>window.GIT_COMMIT = <%- gitCommit %>;</script>",
      "utf8",
    );

    process.env.GIT_COMMIT = "first";
    const first = await getAppShellContent(htmlPath);

    process.env.GIT_COMMIT = "second";
    const second = await getAppShellContent(htmlPath);

    expect(first).toContain('"first"');
    expect(second).toBe(first);
    expect(second).not.toContain('"second"');
  });

  test("sets shared-cache headers for the app shell", () => {
    const headers = new Map<string, string>();
    const response = {
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
    } as any;

    setAppShellCacheHeaders(response);

    expect(headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    );
    expect(headers.get("Content-Type")).toBe("text/html");
  });

  test("renders route-relative asset bases when requested", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "render-html-"));
    const htmlPath = path.join(tempDir, "index.html");
    await fs.writeFile(
      htmlPath,
      [
        '<script src="<%- cdnBaseRaw %>/assets/index.js"></script>',
        "<script>window.CDN_BASE = <%- cdnBase %>;</script>",
      ].join("\n"),
      "utf8",
    );

    const html = await renderHtmlContent(htmlPath, {
      htmlAssetBase: "..",
      viteAssetBase: "..",
    });

    expect(html).toContain('src="../assets/index.js"');
    expect(html).toContain('window.CDN_BASE = ""');
  });

  test("classifies Premiere pages as replay routes before client bootstrap", async () => {
    const html = await renderHtmlContent(path.resolve("index.html"));
    const bootstrapScript = [
      ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
    ]
      .map((match) => match[1])
      .find((script) => script.includes("window.BOOTSTRAP_CONFIG"));
    expect(bootstrapScript).toBeDefined();

    const evaluateRoute = (pathname: string) => {
      const classNames = new Set<string>();
      const windowObject: Record<string, unknown> = {};
      vm.runInNewContext(bootstrapScript!, {
        window: windowObject,
        location: { origin: "https://beta.proxywar.xyz", pathname },
        document: {
          documentElement: {
            classList: {
              add: (...names: string[]) =>
                names.forEach((name) => classNames.add(name)),
            },
            style: { setProperty: () => undefined },
          },
        },
      });
      return { classNames, windowObject };
    };

    const premiere = evaluateRoute("/premiere/prem_0123456789abcdef");
    expect(premiere.windowObject.__PROXYWAR_AI_REPLAY__).toBe(true);
    expect(premiere.classNames).toContain("proxywar-replay-route");
    expect(premiere.windowObject.BOOTSTRAP_CONFIG).toEqual({ gameEnv: "dev" });

    const ordinaryPage = evaluateRoute("/");
    expect(ordinaryPage.windowObject.__PROXYWAR_AI_REPLAY__).toBe(false);
    expect(ordinaryPage.classNames).not.toContain("proxywar-replay-route");
  });
});
