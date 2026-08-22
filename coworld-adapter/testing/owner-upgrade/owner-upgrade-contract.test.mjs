import assert from "node:assert/strict";
import test from "node:test";
import {
  EXISTING_FILES,
  FILES,
  PUBLIC_BASE,
  parseOwnerUpgradeLedger,
} from "./owner-upgrade-contract.mjs";

const sha40 = "1".repeat(40);
const sha64 = "2".repeat(64);

function validLines() {
  return [
    `meta ${PUBLIC_BASE} public-base`,
    `meta ${sha40} candidate-source`,
    `meta ${sha40} candidate-tree`,
    `packet ${sha64} proxywar-owner-upgrade.patch`,
    ...EXISTING_FILES.map((file) => `base ${sha64} ${file}`),
    ...FILES.map((file) => `expected ${sha64} ${file}`),
    ...FILES.map((file) => `source-blob ${sha40} ${file}`),
  ];
}

function parse(lines) {
  return parseOwnerUpgradeLedger(`${lines.join("\n")}\n`);
}

test("owner packet ledger requires the exact complete layer sets", () => {
  const parsed = parse(validLines());
  assert.equal(parsed.candidateSource, sha40);
  assert.equal(parsed.candidateTree, sha40);
  assert.equal(parsed.patchDigest, sha64);
  assert.equal(parsed.baseEntries.size, EXISTING_FILES.length);
  assert.equal(parsed.expectedEntries.size, FILES.length);
  assert.equal(parsed.sourceBlobs.size, FILES.length);
});

test("owner packet ledger rejects omissions, duplicates, extras, and malformed columns", () => {
  const cases = [
    validLines().filter((line) => !line.startsWith("expected ")),
    [...validLines(), `meta ${sha40} candidate-source`],
    [...validLines(), `expected ${sha64} unexpected.mjs`],
    validLines().map((line, index) =>
      index === 0 ? `${line} fourth-column` : line,
    ),
    validLines().map((line, index) =>
      index === 3 ? `unknown ${sha64} proxywar-owner-upgrade.patch` : line,
    ),
    validLines().map((line, index) =>
      index === 3 ? `packet ${sha64} other.patch` : line,
    ),
  ];
  for (const lines of cases) assert.throws(() => parse(lines));
});

test("owner packet ledger rejects wrong digest widths and noncanonical newlines", () => {
  const wrongWidth = validLines();
  wrongWidth[3] = `packet ${sha40} proxywar-owner-upgrade.patch`;
  assert.throws(() => parse(wrongWidth), /wrong digest width/u);
  assert.throws(() => parseOwnerUpgradeLedger(validLines().join("\n")));
  assert.throws(() =>
    parseOwnerUpgradeLedger(`${validLines().join("\r\n")}\r\n`),
  );
});
