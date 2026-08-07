import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import { lookup as lookupMime } from "mrmime";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createHtmlPlugin } from "vite-plugin-html";
import { LEAGUE_WAGERING_STUB_MAP } from "./src/client/prediction/leagueStubs/stubMap";
import {
  type AssetManifest,
  buildAssetUrl,
  rewriteAssetsForCdn,
} from "./src/core/AssetUrls";
import { DEFAULT_PLATFORM_ORIGIN } from "./src/core/PlatformOrigin";
import {
  buildPublicAssetManifest,
  copyRootPublicFiles,
  createHashedPublicAssetFiles,
  getProprietaryDir,
  getResourcesDir,
  writePublicAssetManifest,
} from "./src/server/PublicAssetManifest";

// Vite already handles these, but its good practice to define them explicitly
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function serveProprietaryDir(
  proprietaryDir: string,
  resourcesDir: string,
): Plugin {
  return {
    name: "serve-proprietary-dir",
    configureServer(server) {
      // Must run before Vite's htmlFallback; skip when resources/ has the file
      // so publicDir keeps precedence.
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const rel = decodeURIComponent(
          new URL(req.url, "http://x").pathname,
        ).replace(/^\//, "");
        if (rel.includes("..")) return next();
        if (fs.existsSync(path.join(resourcesDir, rel))) return next();
        const filePath = path.join(proprietaryDir, rel);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
          return next();
        const mime = lookupMime(filePath);
        if (mime) res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

function serveAiLeagueArtifacts(): Plugin {
  return {
    name: "serve-ai-league-artifacts",
    // vite-plugin-html registers a pre-enforced history fallback that rewrites
    // text/html navigations to the app shell; enforce pre (this plugin is
    // earlier in the array) so real artifact files win for browser documents.
    enforce: "pre",
    configureServer(server) {
      const runsDir = path.join(__dirname, "artifacts", "ai-league-runs");
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const url = new URL(req.url, "http://x");
        if (!url.pathname.startsWith("/ai-league-runs/")) {
          return next();
        }
        const rel = decodeURIComponent(
          url.pathname.replace(/^\/ai-league-runs\//, ""),
        );
        if (rel.includes("..")) {
          res.statusCode = 400;
          res.end("invalid ai league artifact path");
          return;
        }
        const filePath = path.join(runsDir, rel);
        if (!filePath.startsWith(runsDir) || !fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.end("ai league artifact not found");
          return;
        }
        if (!fs.statSync(filePath).isFile()) return next();
        const mime = lookupMime(filePath);
        if (mime) res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isProduction = mode === "production";
  const isStaticReplay = mode === "static-replay";
  const usesHashedAssets = isProduction || isStaticReplay;
  // LEAGUE client build: excludes every betting/wagering surface from the
  // bundle (operator boundary 2026-07-27 — speculation lives only on the
  // separate bet surface, never inside the league package). Read straight
  // from process.env, NEVER from loadEnv/.env files, so the switch can only
  // be thrown explicitly by the invoking build (the coworld league image
  // sets it via Dockerfile ENV; beta/bet deployments never set it). Same
  // truthy grammar as the server's envFlag(). End-to-end proof lives in
  // scripts/scan-wagering-sentinel.mjs (`npm run verify:league-client`).
  const leagueClientBuild = ["1", "true", "yes", "on"].includes(
    (process.env.PROXYWAR_LEAGUE_CLIENT ?? "").trim().toLowerCase(),
  );
  // Alias every wagering module that non-wagering client code imports to
  // its inert stub — the map is the single source of truth shared with the
  // stub-parity test. Keying the regex on the path SUFFIX (everything after
  // the importer's "./" / "../" / "src/client" prefix) covers every
  // spelling an import of these modules can take; the `^.*` anchor makes
  // the regex consume the WHOLE specifier, because the rolldown alias
  // plugin substitutes only the matched portion (a bare suffix match would
  // leave the importer's "./" prefix glued onto the absolute stub path).
  const leagueWageringAliases = leagueClientBuild
    ? LEAGUE_WAGERING_STUB_MAP.map((entry) => ({
        find: new RegExp(
          `^.*${entry.realModule
            .replace(/^src\/client/, "")
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        ),
        replacement: path.resolve(__dirname, `${entry.stubModule}.ts`),
      }))
    : [];
  // Backstop behind the alias map: if ANY module under the wagering tree is
  // still loaded (a new import appeared that the stub map does not cover,
  // or an alias regex rotted), fail the league build loudly instead of
  // shipping betting code. `load` sees only modules that made it through
  // resolution, so stubs never trip this.
  const leagueWageringGuard = (): Plugin => ({
    name: "proxywar-league-wagering-guard",
    enforce: "pre",
    load(id) {
      if (id.includes("/src/client/prediction/wagering/")) {
        throw new Error(
          `[PROXYWAR_LEAGUE_CLIENT] wagering module reached the league ` +
            `client build: ${id}. Every import into ` +
            `src/client/prediction/wagering/** must resolve to a stub — ` +
            `add the module to LEAGUE_WAGERING_STUB_MAP ` +
            `(src/client/prediction/leagueStubs/stubMap.ts) with a stub ` +
            `of the same exported names, never widen the league bundle.`,
        );
      }
      return null;
    },
  });
  const resourcesDir = getResourcesDir(__dirname);
  const proprietaryDir = getProprietaryDir(__dirname);
  const sourceDirs = [resourcesDir, proprietaryDir];
  const assetManifest: AssetManifest = usesHashedAssets
    ? buildPublicAssetManifest(sourceDirs)
    : {};
  const cdnBase = isStaticReplay ? "." : (env.CDN_BASE ?? "");
  const htmlAssetData = {
    staticReplay: isStaticReplay,
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(cdnBase),
    gameEnv: JSON.stringify(isStaticReplay ? "prod" : (env.GAME_ENV ?? "dev")),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, cdnBase),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, cdnBase),
    gameplayScreenshotUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      cdnBase,
    ),
    backgroundImageUrl: buildAssetUrl(
      "images/background.webp",
      assetManifest,
      cdnBase,
    ),
    desktopLogoImageUrl: buildAssetUrl(
      "images/OpenFront.png",
      assetManifest,
      cdnBase,
    ),
    mobileLogoImageUrl: buildAssetUrl("images/OF.png", assetManifest, cdnBase),
    // index.html's social block is rendered by THREE callers, not two: the two
    // runtime EJS renderers (RenderHtml.ts and the clip worker's capture host)
    // and this build/dev-time vite-plugin-html pass. Omitting these here does
    // not affect production — it serves prebuilt HTML — but it makes every dev
    // server page a 500, which is how it went unnoticed. Dev has no public
    // origin, so relative values are correct rather than merely a placeholder
    // — EXCEPT the bare root "/" specifically: `<link rel="canonical" href="/">`
    // reads as a real asset URL to Vite's OWN (not vite-plugin-html's) html
    // transform, which resolves "/" to the project root and tries to
    // `readFile()` it, throwing `EISDIR` and failing `vite build --mode
    // development` outright (`npm run build-dev`) — never surfaced via `npm
    // run dev`, which only ever runs the dev SERVER, not a build. An absolute
    // URL short-circuits Vite's asset resolution (`isAbsoluteUrl` in
    // `AssetUrls.ts`'s `buildAssetUrl` — same guard Vite's own html plugin
    // uses) before it ever touches the filesystem.
    socialPageUrl: "http://localhost/",
    socialImageUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      cdnBase,
    ),
  };

  // Vite's HTML transform replaces the source <script src="/src/client/Main.ts">
  // with the hashed bundle URL and injects <link rel="modulepreload"> /
  // <link rel="stylesheet"> tags. rewriteAssetsForCdn rewrites those refs to
  // an EJS placeholder so RenderHtml.ts can prefix them with CDN_BASE at
  // request time.
  const injectCdnBaseTemplate = (): Plugin => ({
    name: "inject-cdn-base-template",
    apply: "build" as const,
    enforce: "post",
    transformIndexHtml: rewriteAssetsForCdn,
  });

  let viteBundleFiles: string[] = [];
  const syncHashedPublicAssets = (includeRootPublicFiles: boolean): Plugin => ({
    name: "sync-hashed-public-assets",
    apply: "build" as const,
    writeBundle(_options, bundle) {
      viteBundleFiles = Object.keys(bundle);
    },
    closeBundle() {
      const outDir = path.join(__dirname, "static");
      if (includeRootPublicFiles) {
        copyRootPublicFiles(resourcesDir, outDir);
      }
      // Run the source→hashed copy first; createHashedPublicAssetFiles iterates
      // assetManifest and expects every key to resolve to a file in resources/
      // or proprietary/. Vite's bundle output (assets/...) doesn't, so it's
      // merged in after.
      createHashedPublicAssetFiles(sourceDirs, outDir, assetManifest);
      // Track Vite's own bundle output (vendor chunks, JS, CSS, workers under
      // static/assets/) in the manifest so the deploy-time R2 upload covers
      // them alongside the hashed source assets. Skip non-assets/ emits like
      // index.html — those are served by the app, not from R2.
      for (const fileName of viteBundleFiles) {
        if (!fileName.startsWith("assets/")) continue;
        assetManifest[fileName] = `/${fileName}`;
      }
      writePublicAssetManifest(outDir, assetManifest);
    },
  });

  // In dev, redirect visits to /w*/game/* to "/" so Vite serves the index.html.
  const devGameHtmlBypass = (req?: {
    url?: string;
    method?: string;
    headers?: { accept?: string | string[] };
  }) => {
    if (req?.method !== "GET") return undefined;
    const accept = req.headers?.accept;
    const acceptValue = Array.isArray(accept)
      ? accept.join(",")
      : (accept ?? "");
    if (!acceptValue.includes("text/html")) return undefined;
    if (!req.url) return undefined;
    if (/^\/w\d+\/game\/[^/]+/.test(req.url)) {
      return "/";
    }
    return undefined;
  };

  return {
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./tests/setup.ts",
      // vitest REPLACES its default `exclude` when this is set, so the
      // defaults (node_modules, dist, …) are restated here, plus artifacts/
      // and outputs/ so archived test copies under artifacts/ (pre-rename
      // cleanup snapshots) are not scanned as live tests, and .claude/ plus
      // .codex/ so test copies inside sibling-session git worktrees are not
      // scanned as live tests of this checkout. deploy/ holds node:test
      // (`.test.mjs`) launchd suites run via `node --test`, not vitest; scanning
      // them as vitest suites reports a spurious failure.
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/cypress/**",
        "**/.{idea,git,cache,output,temp}/**",
        "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
        "**/artifacts/**",
        "**/outputs/**",
        "**/.claude/**",
        "**/.codex/**",
        "**/deploy/**",
      ],
    },
    root: "./",
    base: isStaticReplay ? "./" : "/",
    publicDir: usesHashedAssets ? false : "resources",

    resolve: {
      tsconfigPaths: true,
      alias: [
        {
          find: "resources",
          replacement: path.resolve(__dirname, "resources"),
        },
        ...leagueWageringAliases,
      ],
    },

    optimizeDeps: {
      entries: ["index.html"],
    },

    plugins: [
      ...(leagueClientBuild ? [leagueWageringGuard()] : []),
      ...(!usesHashedAssets
        ? [serveProprietaryDir(proprietaryDir, resourcesDir)]
        : []),
      ...(!usesHashedAssets ? [serveAiLeagueArtifacts()] : []),
      ...(isProduction
        ? []
        : [
            createHtmlPlugin({
              minify: false,
              pages: [
                {
                  filename: "index.html",
                  template: "index.html",
                  entry: "/src/client/Main.ts",
                  injectOptions: {
                    data: {
                      gitCommit: JSON.stringify("DEV"),
                      ...htmlAssetData,
                    },
                  },
                },
                ...(!isStaticReplay
                  ? [
                      {
                        filename: "public.html",
                        template: "public.html",
                        entry: "/src/client/PublicApp.ts",
                        injectOptions: {
                          data: {
                            gitCommit: JSON.stringify("DEV"),
                            ...htmlAssetData,
                          },
                        },
                      },
                    ]
                  : []),
              ],
            }),
          ]),
      ...(isProduction ? [injectCdnBaseTemplate()] : []),
      ...(usesHashedAssets ? [syncHashedPublicAssets(!isStaticReplay)] : []),
      tailwindcss(),
    ],

    define: {
      __ASSET_MANIFEST__: JSON.stringify(assetManifest),
      "process.env.WEBSOCKET_URL": JSON.stringify(
        usesHashedAssets ? "" : "localhost:3000",
      ),
      "process.env.GAME_ENV": JSON.stringify(usesHashedAssets ? "prod" : "dev"),
      "process.env.STRIPE_PUBLISHABLE_KEY": JSON.stringify(
        env.STRIPE_PUBLISHABLE_KEY,
      ),
      "process.env.API_DOMAIN": JSON.stringify(env.API_DOMAIN),
      // The platform/account origin the client links profiles at, and fetches
      // PoV claims from. Injected rather than hardcoded because it moves; the
      // fallback is the ONE shared default, so a build that forgets the env
      // still agrees with the CSP the serving process emits.
      "process.env.PROXYWAR_PLATFORM_ORIGIN": JSON.stringify(
        env.PROXYWAR_PLATFORM_ORIGIN ?? DEFAULT_PLATFORM_ORIGIN,
      ),
      // Add other process.env variables if needed, OR migrate code to import.meta.env
    },

    build: {
      outDir: "static", // Webpack outputs to 'static', assuming we want to keep this.
      emptyOutDir: true,
      assetsDir: "assets", // Sub-directory for assets
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
          ...(!isStaticReplay
            ? { public: path.resolve(__dirname, "public.html") }
            : {}),
        },
        output: {
          // Split, not one shared "vendor": the public entry (PublicApp.ts)
          // never imports pixi.js, only zod (ReadModelSchema.ts). A single
          // combined chunk keyed on either module would put pixi.js in the
          // one chunk BOTH entries depend on merely because they both need
          // zod — silently reintroducing the game bundle on public routes
          // this split exists to remove. Keeping them apart means each
          // entry's own chunk graph only pulls what it actually imports.
          manualChunks: (id) => {
            if (id.includes("pixi.js")) return "vendor-game";
            if (id.includes("zod")) return "vendor-shared";
          },
        },
      },
    },

    server: {
      port: 9000,
      watch: {
        ignored: ["**/artifacts/**", "**/outputs/**"],
      },
      // Automatically open the browser when the server starts
      open: process.env.SKIP_BROWSER_OPEN !== "true",
      hmr:
        env.AI_LEAGUE_DEMO_HMR_DIRECT === "true"
          ? {
              host: "127.0.0.1",
              port: Number(env.AI_LEAGUE_RENDERER_PORT ?? "9000"),
              clientPort: Number(env.AI_LEAGUE_RENDERER_PORT ?? "9000"),
            }
          : undefined,
      proxy: {
        "/lobbies": {
          target: "ws://localhost:3000",
          ws: true,
          changeOrigin: true,
        },
        // Worker proxies
        "/w0": {
          target: "ws://localhost:3001",
          ws: true,
          secure: false,
          changeOrigin: true,
          bypass: (req) => devGameHtmlBypass(req),
          rewrite: (path) => path.replace(/^\/w0/, ""),
        },
        "/w1": {
          target: "ws://localhost:3002",
          ws: true,
          secure: false,
          changeOrigin: true,
          bypass: (req) => devGameHtmlBypass(req),
          rewrite: (path) => path.replace(/^\/w1/, ""),
        },
        // API proxies
        "/api": {
          target: "http://localhost:3000",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
