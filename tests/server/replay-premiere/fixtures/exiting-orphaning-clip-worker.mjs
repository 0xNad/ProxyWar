/**
 * Default-worker fixture for the ordinary-exit containment boundary.
 *
 * An intermediate helper spawns a long-lived grandchild and exits, reparenting
 * that grandchild away from the worker's PID tree while preserving the default
 * worker's detached PGID. The worker records both PIDs and exits nonzero; the
 * service must synchronously SIGKILL the remaining PGID on the exit event,
 * without waiting for its job timeout.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const scratchDir = process.env.PROXYWAR_CLIP_SCRATCH_DIR;
if (!scratchDir) {
  throw new Error("exiting orphan fixture requires PROXYWAR_CLIP_SCRATCH_DIR");
}
const grandchildPidPath = path.join(scratchDir, "exiting-grandchild-pid.txt");
const intermediate = spawn(
  process.execPath,
  [
    "-e",
    `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn("sleep", ["300"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));
      child.unref();
    `,
  ],
  { stdio: "ignore" },
);
await new Promise((resolve, reject) => {
  intermediate.once("error", reject);
  intermediate.once("exit", resolve);
});

const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8").trim());
writeFileSync(
  path.join(scratchDir, "exiting-orphan-pids.txt"),
  `${process.pid} ${grandchildPid}`,
);
process.exit(17);
