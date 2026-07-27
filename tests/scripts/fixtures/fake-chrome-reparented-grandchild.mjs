#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const userDataArgument = process.argv.find((argument) =>
  argument.startsWith("--user-data-dir="),
);
if (userDataArgument === undefined) {
  throw new Error("fake Chrome requires --user-data-dir");
}
const userDataDir = userDataArgument.slice("--user-data-dir=".length);
await writeFile(
  path.join(userDataDir, "fixture-root.pid"),
  String(process.pid),
);

const grandchildPidPath = path.join(userDataDir, "fixture-grandchild.pid");
const intermediate = spawn(
  process.execPath,
  [
    "-e",
    `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        { stdio: "ignore" },
      );
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

// Exit before writing DevToolsActivePort. The long-lived grandchild has now
// lost both its parent and grandparent, but retains the detached worker PGID.
process.exit(23);
