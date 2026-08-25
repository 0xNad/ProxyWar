import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedBase =
  "public.ecr.aws/q5f4m8t9/cogames@sha256:6cb946c338fa3d58685f280a4e6853e2194b2a6a0cbb60001a99342094d9a244";

test("pins the dependency graph, immutable base, and executable build docs", async () => {
  const [packageJsonText, lockText, dockerfile, readme] = await Promise.all([
    readFile(new URL("package.json", import.meta.url), "utf8"),
    readFile(new URL("package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("README.md", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const lock = JSON.parse(lockText);

  assert.deepEqual(packageJson.dependencies, { ws: "8.21.3" });
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, packageJson.dependencies);
  assert.match(dockerfile, new RegExp(`^FROM ${expectedBase}$`, "m"));
  assert.match(dockerfile, /^ARG MITO_SOURCE_SHA$/m);
  assert.ok(
    dockerfile.includes(
      "RUN printf '%s\\n' \"${MITO_SOURCE_SHA}\" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'",
    ),
  );
  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.revision="\$\{MITO_SOURCE_SHA\}"/,
  );
  assert.doesNotMatch(dockerfile, /\bnpm install\b/);
  assert.match(
    readme,
    /--build-arg "MITO_SOURCE_SHA=<exact-source-sha>"[\s\S]*-f coworld-adapter\/mitochondria-friend\/Dockerfile[\s\S]*-t proxywar-mitochondria-friend:local[\s\S]*\n {2}\./,
  );
  assert.doesNotMatch(readme, /\. < exact-source-sha > -f/);
});
