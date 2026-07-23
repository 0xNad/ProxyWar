import { promises as fs } from "node:fs";
import { launchHeadlessChrome } from "../../../src/scripts/replay-premiere-clip-render-lib";

const [userDataDir, chromeBinary, resultPath] = process.argv.slice(2);
if (
  userDataDir === undefined ||
  chromeBinary === undefined ||
  resultPath === undefined
) {
  throw new Error(
    "usage: harness <user-data-dir> <chrome-binary> <result-path>",
  );
}

let result: { ok: boolean; error?: string };
try {
  await launchHeadlessChrome({
    userDataDir,
    chromeBinary,
    timeoutMs: 2_000,
  });
  result = { ok: false, error: "launcher unexpectedly returned" };
} catch (error) {
  result = { ok: true, error: String(error) };
}
await fs.writeFile(resultPath, JSON.stringify(result));
