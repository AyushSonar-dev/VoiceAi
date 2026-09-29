import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { __resetStoreForTests, initStore, getStore, getMode } from "../src/db/index.js";

// A host that cannot resolve: the fastest possible "database is unreachable".
const DEAD_URI = "mongodb+srv://user:pass@echolabs-unreachable-test.invalid/db";

type MutableConfig = { mongoUri: string; requireMongo: boolean };

let saved: MutableConfig;

beforeEach(() => {
  __resetStoreForTests();
  saved = {
    mongoUri: (config as MutableConfig).mongoUri,
    requireMongo: (config as MutableConfig).requireMongo,
  };
});

afterEach(() => {
  (config as MutableConfig).mongoUri = saved.mongoUri;
  (config as MutableConfig).requireMongo = saved.requireMongo;
  __resetStoreForTests();
});

test("an unreachable MONGODB_URI still boots, on the in-memory store", async () => {
  (config as MutableConfig).mongoUri = DEAD_URI;
  (config as MutableConfig).requireMongo = false;

  // Must NOT throw: a dead database cannot take the tool gateway — and with it
  // the whole website — down.
  const store = await initStore();
  assert.equal(getMode(), "memory");

  // and it must be a working store, not a broken placeholder
  const products = await store.searchProducts({ limit: 3 });
  assert.ok(products.length > 0, "the fallback store must still serve the catalog");
  for (const p of products) {
    assert.ok(p.name && p.category, "each product must carry its catalog identity");
    assert.ok(p.appearance?.summary, "the seeded catalog ships a visual description for every product");
  }

  const session = await store.getOrCreateSession("boot-test-session");
  assert.ok(session.sessionId);
  assert.equal(getStore(), store);
});

test("REQUIRE_MONGO=true makes an unreachable database fatal instead", async () => {
  (config as MutableConfig).mongoUri = DEAD_URI;
  (config as MutableConfig).requireMongo = true;

  await assert.rejects(() => initStore(), /ENOTFOUND|EAI_AGAIN|querySrv|Mongo/i);
  assert.equal(getMode(), null, "no store should be left half-initialized");
});

test("no MONGODB_URI at all still boots on the in-memory store", async () => {
  (config as MutableConfig).mongoUri = "";
  (config as MutableConfig).requireMongo = false;

  await initStore();
  assert.equal(getMode(), "memory");
  assert.ok((await getStore().searchProducts({ limit: 1 })).length > 0);
});
