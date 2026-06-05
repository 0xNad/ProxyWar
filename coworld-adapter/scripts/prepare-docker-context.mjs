import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const proxyWarRepo =
  process.env.PROXYWAR_REPO ?? "/app/proxywar";
const contextRoot = path.join(localRoot, ".docker-context");

const proxyWarEntries = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src",
  "resources",
];

const integrationEntries = [
  "package.json",
  "package-lock.json",
  "README.md",
  "coworld",
  "docs",
  "src",
];

await fs.rm(contextRoot, { recursive: true, force: true });
await fs.mkdir(contextRoot, { recursive: true });

await copyEntries(proxyWarRepo, path.join(contextRoot, "proxywar"), proxyWarEntries);
await copyEntries(localRoot, path.join(contextRoot, "integration"), integrationEntries);
await fs.copyFile(
  path.join(localRoot, "Dockerfile.coworld"),
  path.join(contextRoot, "Dockerfile.coworld"),
);
await fs.writeFile(
  path.join(contextRoot, ".dockerignore"),
  [
    ".git",
    "node_modules",
    "artifacts",
    ".docker-context",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    ".DS_Store",
    "",
  ].join("\n"),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      contextRoot,
      proxyWarRepo,
      proxyWarEntries,
      integrationEntries,
    },
    null,
    2,
  ),
);

async function copyEntries(sourceRoot, targetRoot, entries) {
  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry);
    const target = path.join(targetRoot, entry);
    await fs.cp(source, target, {
      recursive: true,
      filter: shouldCopy,
    });
  }
}

function shouldCopy(source) {
  const name = path.basename(source);
  if (
    name === ".git" ||
    name === "node_modules" ||
    name === "artifacts" ||
    name === ".docker-context" ||
    name === ".DS_Store" ||
    name === "coverage" ||
    name === "dist" ||
    name === "build" ||
    name === "tmp" ||
    name === "logs"
  ) {
    return false;
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return false;
  }
  if (name.endsWith(".pem") || name.endsWith(".key")) {
    return false;
  }
  return true;
}
