#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const imageRef = /^[A-Za-z0-9._:/-]+$/;
const args = process.argv.slice(2);
const realDocker = process.env.COWORLD_REAL_DOCKER;

if (!realDocker || !isAbsolute(realDocker)) {
  throw new Error("COWORLD_REAL_DOCKER must be an absolute path");
}

const isImageRef = (value) =>
  typeof value === "string" &&
  imageRef.test(value) &&
  !value.startsWith("-") &&
  !value.startsWith("sha256:");

const allowed =
  (args.length === 3 &&
    args[0] === "image" &&
    args[1] === "inspect" &&
    isImageRef(args[2])) ||
  (args.length === 5 &&
    args[0] === "image" &&
    args[1] === "inspect" &&
    args[2] === "--format" &&
    args[3] === "{{.Id}}" &&
    isImageRef(args[4])) ||
  (args.length === 3 &&
    args[0] === "image" &&
    args[1] === "save" &&
    isImageRef(args[2]));

if (!allowed) {
  process.stderr.write(
    `Coworld production Docker guard rejected operation: ${args.slice(0, 2).join(" ") || "<empty>"}\n`,
  );
  process.exit(126);
}

const result = spawnSync(realDocker, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
