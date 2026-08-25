import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const OWNER_EVIDENCE_MAX_FILE_BYTES = 16 * 1024 * 1024;

const SIMPLE_BYTE_ESCAPES = new Map([
  ["\\", 0x5c],
  ["'", 0x27],
  ['"', 0x22],
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
]);

function fail(message) {
  throw new Error(message);
}

function strictUtf8(bytes, description) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${description} is not strict UTF-8`);
  }
}

function decodePythonBytesLiteral(text, maxBytes) {
  let end = text.length;
  if (text.endsWith("\r\n")) end -= 2;
  else if (text.endsWith("\n")) end -= 1;
  if (end < 3 || text[0] !== "b" || !["'", '"'].includes(text[1])) {
    fail("Coworld policy log is not an exact Python bytes literal");
  }
  const quote = text[1];
  if (text[end - 1] !== quote) {
    fail("Coworld policy log has a truncated Python bytes literal");
  }
  const output = [];
  const append = (value) => {
    if (output.length >= maxBytes) {
      fail(`normalized policy log exceeds ${maxBytes} bytes`);
    }
    output.push(value);
  };
  for (let index = 2; index < end - 1; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7f || code < 0x20 || code === 0x7f) {
      fail("Coworld Python bytes literal contains an unescaped byte");
    }
    const character = text[index];
    if (character === quote) {
      fail("Coworld Python bytes literal contains an unescaped quote");
    }
    if (character !== "\\") {
      append(code);
      continue;
    }
    index += 1;
    if (index >= end - 1) {
      fail("Coworld Python bytes literal has a truncated escape");
    }
    const escape = text[index];
    if (SIMPLE_BYTE_ESCAPES.has(escape)) {
      append(SIMPLE_BYTE_ESCAPES.get(escape));
      continue;
    }
    if (escape !== "x" || index + 2 >= end - 1) {
      fail("Coworld Python bytes literal contains an unsupported escape");
    }
    const hex = text.slice(index + 1, index + 3);
    if (!/^[0-9a-fA-F]{2}$/u.test(hex)) {
      fail("Coworld Python bytes literal contains a malformed hex escape");
    }
    append(Number.parseInt(hex, 16));
    index += 2;
  }
  return Buffer.from(output);
}

export function normalizeCoworldPolicyLog(
  input,
  { maxBytes = OWNER_EVIDENCE_MAX_FILE_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("policy log input must be bytes");
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength > maxBytes) {
    fail(`policy log exceeds ${maxBytes} bytes`);
  }
  const text = strictUtf8(bytes, "policy log");
  const wrapped = text.startsWith("b'") || text.startsWith('b"');
  const normalized = wrapped
    ? decodePythonBytesLiteral(text, maxBytes)
    : Buffer.from(bytes);
  strictUtf8(normalized, "normalized policy log");
  return {
    bytes: normalized,
    format: wrapped ? "python-bytes-literal" : "plain-utf8",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBoundedRegularFile(fileDescriptor, fileSize) {
  const input = Buffer.alloc(fileSize);
  let offset = 0;
  while (offset < fileSize) {
    const bytesRead = fs.readSync(
      fileDescriptor,
      input,
      offset,
      fileSize - offset,
      offset,
    );
    if (bytesRead === 0) {
      fail("input policy log changed while it was being read");
    }
    offset += bytesRead;
  }
  const trailingByte = Buffer.alloc(1);
  if (fs.readSync(fileDescriptor, trailingByte, 0, 1, fileSize) !== 0) {
    fail("input policy log changed while it was being read");
  }
  return input;
}

function main(argv) {
  if (argv.length !== 2) {
    fail("usage: node owner-evidence-normalize.mjs INPUT_LOG OUTPUT_LOG");
  }
  const inputPath = fs.realpathSync(argv[0]);
  const outputPath = path.resolve(argv[1]);
  if (outputPath === inputPath) {
    fail("refusing to overwrite the source policy log");
  }
  const inputDescriptor = fs.openSync(
    inputPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let input;
  try {
    const inputStat = fs.fstatSync(inputDescriptor);
    if (!inputStat.isFile()) fail("input policy log must be a regular file");
    if (
      !Number.isSafeInteger(inputStat.size) ||
      inputStat.size > OWNER_EVIDENCE_MAX_FILE_BYTES
    ) {
      fail(`policy log exceeds ${OWNER_EVIDENCE_MAX_FILE_BYTES} bytes`);
    }
    input = readBoundedRegularFile(inputDescriptor, inputStat.size);
  } finally {
    fs.closeSync(inputDescriptor);
  }
  const normalized = normalizeCoworldPolicyLog(input);
  fs.writeFileSync(outputPath, normalized.bytes, {
    encoding: null,
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({
      verdict: "NORMALIZED",
      format: normalized.format,
      inputBytes: input.byteLength,
      outputBytes: normalized.bytes.byteLength,
      inputSHA256: sha256(input),
      outputSHA256: sha256(normalized.bytes),
      output: outputPath,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
