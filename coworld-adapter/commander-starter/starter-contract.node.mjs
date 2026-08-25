import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedBase =
  "public.ecr.aws/q5f4m8t9/cogames@sha256:6cb946c338fa3d58685f280a4e6853e2194b2a6a0cbb60001a99342094d9a244";
const expectedPlayer = "/app/proxywar/coworld-adapter/src/commander-player.ts";
const expectedModel = "us.anthropic.claude-sonnet-4-6";

test("pins the hosted-tested image and installs the production Commander entrypoint", async () => {
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
  assert.match(dockerfile, /^COPY commander-player\.ts /m);
  assert.match(dockerfile, /^COPY commander-production-runtime\.ts /m);
  assert.doesNotMatch(dockerfile, /commander-xp-player/);
  assert.doesNotMatch(dockerfile, /--arm=/);
});

test("launch uploads the production argv with the exact Bedrock model", async () => {
  const launch = await readFile(new URL("launch.sh", import.meta.url), "utf8");
  assert.match(launch, new RegExp(expectedPlayer.replaceAll("/", "\\/")));
  assert.match(launch, new RegExp(`MODEL="${expectedModel}"`));
  assert.match(launch, /--bedrock-model "\$MODEL"/);
  assert.match(launch, /coworld submit/);
  assert.doesNotMatch(launch, /commander-xp-player/);
  assert.doesNotMatch(launch, /--arm=/);
});

test("the public contract states the exact-action and fallback boundaries", async () => {
  const readme = await readFile(new URL("README.md", import.meta.url), "utf8");
  assert.match(readme, /exact\s+currently offered `LegalAction\.id`/);
  assert.match(readme, /explicit\s+deterministic fallback/);
  assert.match(readme, /19 of 74/);
  assert.match(readme, /55-second inference budget/);
  assert.match(readme, /60-second gameplay response window/);
  assert.match(readme, /removes the\s+canary's eval run key/);
  assert.match(
    readme,
    /structured deals and bounded free-form message replies/,
  );
});
