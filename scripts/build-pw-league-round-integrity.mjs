#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const ROUND_INTEGRITY_SOURCE_PATH = path.resolve(
  scriptDir,
  "../src/server/agents/CoworldLeagueRoundIntegrity.ts",
);

/**
 * Emits the repository's tested TypeScript detector as a dependency-free ESM
 * artifact (its only runtime import is node:crypto). The machine-local
 * `pw-league-sentinel.mjs` installer can stage this exact artifact and import
 * its evaluator/signal adapter; no predicates need to be copied by hand.
 */
export async function buildPwLeagueRoundIntegrityArtifact({
  outputPath,
  overwrite = false,
}) {
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    throw new Error("outputPath must be an absolute path");
  }
  if (!overwrite) {
    try {
      await fs.access(outputPath);
      throw new Error(`Refusing to overwrite existing artifact: ${outputPath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const source = await fs.readFile(ROUND_INTEGRITY_SOURCE_PATH, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: ROUND_INTEGRITY_SOURCE_PATH,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      removeComments: false,
      sourceMap: false,
      declaration: false,
    },
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      `Round-integrity artifact compilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  const body = [
    "// Generated from src/server/agents/CoworldLeagueRoundIntegrity.ts.",
    "// Do not edit this artifact; rebuild it from the tested repository source.",
    compiled.outputText,
  ].join("\n");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o644 });
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    sourcePath: ROUND_INTEGRITY_SOURCE_PATH,
    outputPath,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function parseOutputPath(argv) {
  const index = argv.indexOf("--output");
  const outputPath = index === -1 ? undefined : argv[index + 1];
  if (outputPath === undefined) {
    throw new Error(
      "Usage: node scripts/build-pw-league-round-integrity.mjs --output <absolute-path> [--overwrite]",
    );
  }
  return {
    outputPath,
    overwrite: argv.includes("--overwrite"),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  buildPwLeagueRoundIntegrityArtifact(parseOutputPath(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    });
}
