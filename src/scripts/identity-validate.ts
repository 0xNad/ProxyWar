import { loadIdentityRegistrySnapshot } from "../server/identity/IdentityRegistry";
import { validateIdentityRegistrySnapshot } from "../server/identity/IdentityValidation";

/**
 * `npm run identity:validate` — loads all three registry files (Zod schema
 * parse happens on load; anything that fails there throws before this
 * function even runs) and runs referential-integrity, uniqueness, and
 * secret-shaped-string checks over the result. Exits non-zero on any error
 * so it gates CI/operator review; warnings print but don't fail the run.
 */
async function main(): Promise<void> {
  const dir = process.argv.includes("--dir")
    ? process.argv[process.argv.indexOf("--dir") + 1]
    : undefined;
  const snapshot = await loadIdentityRegistrySnapshot(dir);
  const { errors, warnings } = validateIdentityRegistrySnapshot(snapshot);

  console.log(
    `identity:validate — ${snapshot.builders.length} builders, ${snapshot.agents.length} agents, ${snapshot.versions.length} versions`,
  );
  for (const warning of warnings) {
    console.warn(`WARN  ${warning}`);
  }
  for (const error of errors) {
    console.error(`ERROR ${error}`);
  }
  if (errors.length > 0) {
    console.error(`identity:validate — FAILED (${errors.length} error(s), ${warnings.length} warning(s))`);
    process.exitCode = 1;
    return;
  }
  console.log(`identity:validate — OK (${warnings.length} warning(s))`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
