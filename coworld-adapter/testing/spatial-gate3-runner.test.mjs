import assert from "node:assert/strict";
import test from "node:test";

import { decodePythonBytesLiteral } from "./run-spatial-gate3-xps.mjs";

test("decodes Coworld Python bytes log output exactly", () => {
  const encoded = String.raw`b'line one\nJSON {"text":"it\'s fine"}\nutf8=\xe2\x98\x83\n'`;
  assert.equal(
    decodePythonBytesLiteral(encoded).toString("utf8"),
    'line one\nJSON {"text":"it\'s fine"}\nutf8=☃\n',
  );
});

test("rejects malformed byte literals and escapes", () => {
  assert.throws(() => decodePythonBytesLiteral("plain text"), /bytes literal/u);
  assert.throws(
    () => decodePythonBytesLiteral(String.raw`b'\x0'`),
    /hex escape/u,
  );
});
