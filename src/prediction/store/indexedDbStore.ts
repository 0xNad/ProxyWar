/**
 * IndexedDB implementation of `PredictionStore` — SPEC §8.
 *
 * Hand-rolled (the spec allows `idb-keyval` only if already a dependency;
 * it isn't, so no dependency is added). Five object stores: `seasons`
 * (keyed by `Season.index`), `stakes` / `resolutions` (keyed by `marketId`,
 * the shared idempotency key), `meta` (a single row holding
 * `seenFixtureIds`), and `checkpointClosures` (keyed by `FixtureId`, an
 * array of closed `CheckpointIndex` — SPEC §9's closed-window record, kept
 * independent of whether any stake exists so a refresh can't reopen a
 * window the player has already been shown).
 *
 * Not exercised by the test suite: jsdom has no IndexedDB implementation
 * and this project does not add `fake-indexeddb` as a dependency. SPEC's
 * storage tests target `store/memoryStore.ts`, which implements the
 * identical contract and idempotency guarantees.
 */
import type { CheckpointIndex, FixtureId, Resolution, Season, Stake } from "../types";
import { marketId } from "../types";
import { resolutionsEqual, stakesEqual } from "../engine/ledger";
import { summarizeSeason } from "../engine/summary";
import type { PredictionStore } from "./PredictionStore";

const SEASONS_STORE = "seasons";
const STAKES_STORE = "stakes";
const RESOLUTIONS_STORE = "resolutions";
const META_STORE = "meta";
const CHECKPOINT_CLOSURES_STORE = "checkpointClosures";
const SEEN_FIXTURES_KEY = "seenFixtureIds";
const DB_VERSION = 2; // v2: added CHECKPOINT_CLOSURES_STORE

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SEASONS_STORE)) {
        db.createObjectStore(SEASONS_STORE, { keyPath: "index" });
      }
      if (!db.objectStoreNames.contains(STAKES_STORE)) {
        db.createObjectStore(STAKES_STORE);
      }
      if (!db.objectStoreNames.contains(RESOLUTIONS_STORE)) {
        db.createObjectStore(RESOLUTIONS_STORE);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(CHECKPOINT_CLOSURES_STORE)) {
        db.createObjectStore(CHECKPOINT_CLOSURES_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`failed to open IndexedDB "${dbName}"`));
  });
}

/** Three-plus call sites below all need the same request→promise wiring. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Every write transaction below waits on completion before returning. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function createIndexedDbPredictionStore(
  dbName = "proxywar-prediction",
): PredictionStore {
  const dbPromise = openDatabase(dbName);

  return {
    async loadSeason() {
      const db = await dbPromise;
      const tx = db.transaction(SEASONS_STORE, "readonly");
      const all = await requestToPromise<Season[]>(
        tx.objectStore(SEASONS_STORE).getAll(),
      );
      await txDone(tx);
      if (all.length === 0) return null;
      return all.reduce((latest, s) => (s.index > latest.index ? s : latest));
    },

    async saveSeason(season) {
      const db = await dbPromise;
      const tx = db.transaction(SEASONS_STORE, "readwrite");
      tx.objectStore(SEASONS_STORE).put(season);
      await txDone(tx);
    },

    async listSeasons() {
      const db = await dbPromise;
      const tx = db.transaction(SEASONS_STORE, "readonly");
      const all = await requestToPromise<Season[]>(
        tx.objectStore(SEASONS_STORE).getAll(),
      );
      await txDone(tx);
      return all.sort((a, b) => a.index - b.index).map(summarizeSeason);
    },

    async recordStake(stake) {
      const key = marketId(stake.fixtureId, stake.checkpointIndex, stake.kind);
      const db = await dbPromise;
      const tx = db.transaction(STAKES_STORE, "readwrite");
      const store = tx.objectStore(STAKES_STORE);
      const existing = await requestToPromise<Stake | undefined>(store.get(key));
      if (existing !== undefined) {
        await txDone(tx);
        if (stakesEqual(existing, stake)) return;
        throw new Error(
          `recordStake: market ${key} already has a different stake recorded`,
        );
      }
      store.put(stake, key);
      await txDone(tx);
    },

    async recordResolution(resolution) {
      const key = marketId(
        resolution.fixtureId,
        resolution.checkpointIndex,
        resolution.kind,
      );
      const db = await dbPromise;
      const tx = db.transaction(RESOLUTIONS_STORE, "readwrite");
      const store = tx.objectStore(RESOLUTIONS_STORE);
      const existing = await requestToPromise<Resolution | undefined>(
        store.get(key),
      );
      if (existing !== undefined) {
        await txDone(tx);
        if (resolutionsEqual(existing, resolution)) return;
        throw new Error(
          `recordResolution: market ${key} already has a different resolution recorded`,
        );
      }
      store.put(resolution, key);
      await txDone(tx);
    },

    async loadSeenFixtureIds() {
      const db = await dbPromise;
      const tx = db.transaction(META_STORE, "readonly");
      const ids = await requestToPromise<FixtureId[] | undefined>(
        tx.objectStore(META_STORE).get(SEEN_FIXTURES_KEY),
      );
      await txDone(tx);
      return new Set(ids ?? []);
    },

    async markFixtureSeen(fixtureId) {
      const db = await dbPromise;
      const tx = db.transaction(META_STORE, "readwrite");
      const store = tx.objectStore(META_STORE);
      const existing =
        (await requestToPromise<FixtureId[] | undefined>(
          store.get(SEEN_FIXTURES_KEY),
        )) ?? [];
      if (!existing.includes(fixtureId)) {
        store.put([...existing, fixtureId], SEEN_FIXTURES_KEY);
      }
      await txDone(tx);
    },

    async loadClosedCheckpoints(fixtureId) {
      const db = await dbPromise;
      const tx = db.transaction(CHECKPOINT_CLOSURES_STORE, "readonly");
      const closed = await requestToPromise<CheckpointIndex[] | undefined>(
        tx.objectStore(CHECKPOINT_CLOSURES_STORE).get(fixtureId),
      );
      await txDone(tx);
      return closed ?? [];
    },

    async recordCheckpointClosed(fixtureId, checkpointIndex) {
      const db = await dbPromise;
      const tx = db.transaction(CHECKPOINT_CLOSURES_STORE, "readwrite");
      const store = tx.objectStore(CHECKPOINT_CLOSURES_STORE);
      const existing =
        (await requestToPromise<CheckpointIndex[] | undefined>(
          store.get(fixtureId),
        )) ?? [];
      if (!existing.includes(checkpointIndex)) {
        store.put([...existing, checkpointIndex], fixtureId);
      }
      await txDone(tx);
    },
  };
}
