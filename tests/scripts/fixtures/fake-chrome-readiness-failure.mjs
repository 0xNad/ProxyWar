#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const userDataArgument = process.argv.find((argument) =>
  argument.startsWith("--user-data-dir="),
);
if (userDataArgument === undefined) {
  throw new Error("fake Chrome requires --user-data-dir");
}
const userDataDir = userDataArgument.slice("--user-data-dir=".length);

const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);
if (descendant.pid === undefined) {
  throw new Error("fake Chrome descendant did not start");
}

await Promise.all([
  writeFile(path.join(userDataDir, "fixture-root.pid"), String(process.pid)),
  writeFile(
    path.join(userDataDir, "fixture-descendant.pid"),
    String(descendant.pid),
  ),
]);

const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  // Deliberately omit webSocketDebuggerUrl so launchHeadlessChrome() fails
  // after it has spawned a descendant but before it can return a disposer.
  response.end(JSON.stringify({ Browser: "FixtureChrome/1.0" }));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("fake Chrome fixture did not bind a TCP port");
}
await writeFile(
  path.join(userDataDir, "DevToolsActivePort"),
  `${address.port}\nfixture-browser-id\n`,
);

setInterval(() => {}, 1_000);
