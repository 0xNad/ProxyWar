/**
 * Test fixture standing in for the clip render worker: spawns a long-lived
 * child (as the real worker spawns Chrome/ffmpeg), reports both pids into the
 * configured scratch dir, then hangs — forcing the service's job timeout so
 * the process-group reap path is exercised for real.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const scratchDir = process.env.PROXYWAR_CLIP_SCRATCH_DIR;
if (!scratchDir) {
  throw new Error("orphaning fixture requires PROXYWAR_CLIP_SCRATCH_DIR");
}
const child = spawn("sleep", ["300"], { stdio: "ignore" });
writeFileSync(
  path.join(scratchDir, "orphan-pids.txt"),
  `${process.pid} ${child.pid}`,
);
// Never exit: the service's jobTimeoutMs SIGKILL must reap this whole tree.
setInterval(() => {}, 1_000);
