import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OWNER_EVIDENCE_MAX_FILE_BYTES,
  normalizeCoworldPolicyLog,
} from "./owner-evidence-normalize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NORMALIZER = path.join(HERE, "owner-evidence-normalize.mjs");

test("owner evidence normalizer preserves strict plain UTF-8", () => {
  const input = Buffer.from("plain policy log\nwith a snowman: ☃\n", "utf8");
  const normalized = normalizeCoworldPolicyLog(input);
  assert.equal(normalized.format, "plain-utf8");
  assert.deepEqual(normalized.bytes, input);
});

test("owner evidence normalizer decodes an exact Python bytes literal", () => {
  const input = Buffer.from(
    String.raw`b'line one\nsnowman: \xe2\x98\x83\\quote:\'\n'`,
    "ascii",
  );
  const normalized = normalizeCoworldPolicyLog(input);
  assert.equal(normalized.format, "python-bytes-literal");
  assert.equal(
    normalized.bytes.toString("utf8"),
    "line one\nsnowman: ☃\\quote:'\n",
  );

  const doubleQuoted = normalizeCoworldPolicyLog(
    Buffer.from(String.raw`b"quoted: \"ok\"\r\n"`),
  );
  assert.equal(doubleQuoted.bytes.toString("utf8"), 'quoted: "ok"\r\n');
});

test("owner evidence normalizer rejects malformed or ambiguous wrappers", () => {
  for (const malformed of [
    String.raw`b'unterminated`,
    String.raw`b'unsupported \q'`,
    String.raw`b'truncated \x0'`,
    "b'unescaped ' quote'",
    "b'ok' trailing",
    "b'ok'\n\n",
    "b'é'",
  ]) {
    assert.throws(
      () => normalizeCoworldPolicyLog(Buffer.from(malformed, "utf8")),
      /Python bytes literal|unsupported escape|malformed hex|unescaped/u,
    );
  }
});

test("owner evidence normalizer rejects invalid UTF-8 and bounded overflow", () => {
  assert.throws(
    () => normalizeCoworldPolicyLog(Buffer.from([0xff])),
    /not strict UTF-8/u,
  );
  assert.throws(
    () => normalizeCoworldPolicyLog(Buffer.from(String.raw`b'\xff'`)),
    /normalized policy log is not strict UTF-8/u,
  );
  assert.throws(
    () =>
      normalizeCoworldPolicyLog(Buffer.from("12345"), {
        maxBytes: 4,
      }),
    /exceeds 4 bytes/u,
  );
});

test("owner evidence normalizer writes a new hashed artifact without overwrite", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "proxywar-owner-normalize-"),
  );
  try {
    const input = path.join(directory, "raw.log");
    const output = path.join(directory, "normalized.log");
    writeFileSync(input, String.raw`b'first\nsecond\n'`, "ascii");
    const result = spawnSync(process.execPath, [NORMALIZER, input, output], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "first\nsecond\n");
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.verdict, "NORMALIZED");
    assert.equal(receipt.format, "python-bytes-literal");
    assert.match(receipt.inputSHA256, /^[0-9a-f]{64}$/u);
    assert.match(receipt.outputSHA256, /^[0-9a-f]{64}$/u);

    const overwrite = spawnSync(
      process.execPath,
      [NORMALIZER, input, output],
      { encoding: "utf8" },
    );
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stderr, /EEXIST|already exists/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner evidence normalizer rejects an oversized sparse file before output", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "proxywar-owner-normalize-sparse-"),
  );
  try {
    const input = path.join(directory, "oversized.log");
    const output = path.join(directory, "must-not-exist.log");
    const descriptor = openSync(input, "wx", 0o600);
    try {
      ftruncateSync(descriptor, OWNER_EVIDENCE_MAX_FILE_BYTES + 1);
    } finally {
      closeSync(descriptor);
    }

    const result = spawnSync(process.execPath, [NORMALIZER, input, output], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`policy log exceeds ${OWNER_EVIDENCE_MAX_FILE_BYTES} bytes`),
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
