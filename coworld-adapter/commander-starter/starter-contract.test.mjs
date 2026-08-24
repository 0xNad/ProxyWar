import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedBase =
  "public.ecr.aws/q5f4m8t9/cogames@sha256:6cb946c338fa3d58685f280a4e6853e2194b2a6a0cbb60001a99342094d9a244";
const expectedPlayer =
  "/app/proxywar/coworld-adapter/src/commander-xp-player.ts";
const expectedModel = "us.anthropic.claude-sonnet-4-6";

test("pins the hosted-tested Commander image and selects only Arm C", async () => {
  const dockerfile = await readFile(
    new URL("Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, new RegExp(`^FROM ${expectedBase}$`, "m"));
  assert.match(dockerfile, /^ARG STARTER_SOURCE_SHA$/m);
  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.revision="\$\{STARTER_SOURCE_SHA\}"/,
  );
  assert.match(dockerfile, new RegExp(expectedPlayer.replaceAll("/", "\\/")));
  assert.match(dockerfile, /"--arm=C"/);
  assert.doesNotMatch(dockerfile, /"--arm=[AB]"/);
});

test("launch uploads the same C argv with the exact Bedrock model", async () => {
  const launch = await readFile(new URL("launch.sh", import.meta.url), "utf8");
  assert.match(launch, /--run=--arm=C/);
  assert.match(launch, new RegExp(`MODEL="${expectedModel}"`));
  assert.match(launch, /--bedrock-model "\$MODEL"/);
  assert.match(launch, /coworld submit/);
  assert.doesNotMatch(launch, /--run=--arm=[AB]/);
});

test("the public contract states the exact-action and fallback boundaries", async () => {
  const readme = await readFile(new URL("README.md", import.meta.url), "utf8");
  assert.match(readme, /exact currently offered `LegalAction\.id`/);
  assert.match(readme, /explicit\s+deterministic fallback/);
  assert.match(readme, /19 of 74/);
  assert.match(
    readme,
    /does\s+not send structured deals or free-form messages/,
  );
});
