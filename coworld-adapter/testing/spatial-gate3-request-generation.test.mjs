import assert from "node:assert/strict";
import test from "node:test";

import {
  ARM_COWORLDS,
  MAP_CLASSES,
  OPPONENT_POLICY,
  PHASES,
  SUBJECT_POLICY,
  buildGate3Requests,
  normalizedRequest,
  validateGate3Requests,
} from "./generate-spatial-gate3-requests.mjs";

test("builds 24 balanced, exact matched OFF/STRUCTURED pairs", () => {
  const entries = buildGate3Requests();
  assert.deepEqual(validateGate3Requests(entries), {
    requestCount: 48,
    setCount: 24,
    offFirst: 12,
    structuredFirst: 12,
  });
  assert.equal(new Set(entries.map((entry) => entry.setID)).size, 24);
  assert.equal(
    new Set(entries.map((entry) => entry.request.idempotency_key)).size,
    48,
  );
  assert.deepEqual(
    new Set(entries.map((entry) => entry.request.target.coworld_id)),
    new Set(Object.values(ARM_COWORLDS)),
  );
});

test("each pair differs only in Coworld treatment identity and evidence labels", () => {
  const entries = buildGate3Requests();
  for (let index = 0; index < entries.length; index += 2) {
    assert.equal(entries[index].setID, entries[index + 1].setID);
    assert.deepEqual(
      normalizedRequest(entries[index].request),
      normalizedRequest(entries[index + 1].request),
    );
  }
});

test("stratifies six maps with four seats/seeds each and one subject", () => {
  const entries = buildGate3Requests();
  for (const mapClass of MAP_CLASSES) {
    const rows = entries.filter((entry) =>
      entry.setID.startsWith(`${mapClass.slug}-`),
    );
    assert.equal(rows.length, 8);
    assert.deepEqual(
      new Set(rows.map((entry) => entry.subjectSlot)),
      new Set([0, 1, 2, 3]),
    );
    assert.equal(
      new Set(rows.map((entry) => entry.request.game_config_overrides.seed))
        .size,
      4,
    );
    for (const entry of rows) {
      const policies = entry.request.roster.map(
        (seat) => seat.player.policy_ref,
      );
      assert.equal(
        policies.filter((policy) => policy === SUBJECT_POLICY).length,
        1,
      );
      assert.equal(
        policies.filter((policy) => policy === OPPONENT_POLICY).length,
        mapClass.players - 1,
      );
      assert.equal(policies[entry.subjectSlot], SUBJECT_POLICY);
      assert.equal(entry.request.target.variant_id, mapClass.variantID);
      assert.equal(
        entry.request.game_config_overrides.num_agents,
        mapClass.players,
      );
      assert.equal(entry.request.game_config_overrides.map, mapClass.map);
      assert.equal(
        entry.request.game_config_overrides.map_size,
        mapClass.mapSize,
      );
    }
  }
});

test("builds 48 new confirmatory pairs with disjoint seeds and balanced order", () => {
  const canary = buildGate3Requests("canary");
  const confirmatory = buildGate3Requests("confirmatory");
  assert.deepEqual(validateGate3Requests(confirmatory, "confirmatory"), {
    requestCount: 96,
    setCount: 48,
    offFirst: 24,
    structuredFirst: 24,
  });
  assert.equal(PHASES.confirmatory.roundsPerMap, 8);
  assert.equal(new Set(confirmatory.map((entry) => entry.setID)).size, 48);
  assert.equal(
    new Set(confirmatory.map((entry) => entry.request.idempotency_key)).size,
    96,
  );
  const canarySeeds = new Set(
    canary.map((entry) => entry.request.game_config_overrides.seed),
  );
  assert.equal(
    confirmatory.some((entry) =>
      canarySeeds.has(entry.request.game_config_overrides.seed),
    ),
    false,
  );
  for (const mapClass of MAP_CLASSES) {
    const rows = confirmatory.filter((entry) =>
      entry.setID.startsWith(`${mapClass.slug}-`),
    );
    assert.equal(rows.length, 16);
    assert.equal(
      new Set(rows.map((entry) => entry.request.game_config_overrides.seed))
        .size,
      8,
    );
    assert.deepEqual(
      rows
        .filter((entry) => entry.arm === "off")
        .map((entry) => entry.subjectSlot),
      [0, 1, 2, 3, 0, 1, 2, 3],
    );
  }
});
