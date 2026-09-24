import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetStoreForTests, initStore, getStore } from "../src/db/index.js";
import { dispatchTool } from "../src/tools/index.js";
import type { ToolResult } from "../src/types.js";

let sidCounter = 0;
const sessionId = () => `tools-test-${++sidCounter}`;

beforeEach(async () => {
  __resetStoreForTests();
  await initStore({ forceMemory: true });
});

async function searchFirst(sessionId: string, filter: Record<string, unknown>) {
  const r = await dispatchTool("searchProducts", { sessionId, ...filter });
  assert.equal(r.success, true, `search failed: ${r.message}`);
  return (r.data!.items as Array<{ id: string; index: number }>)[0];
}

test("searchProducts returns <=2 options by default and records ids as referenceable", async () => {
  const sid = sessionId();
  const r = await dispatchTool("searchProducts", { sessionId: sid, category: "Jewelry" });
  assert.equal(r.success, true);
  const items = r.data!.items as Array<{ index: number; id: string }>;
  assert.ok(items.length >= 1 && items.length <= 2, `expected 1..2 options, got ${items.length}`);
  assert.equal(items[0].index, 1);
  const session = await getStore().getSession(sid);
  for (const item of items) assert.ok(session!.recentProductIds.includes(item.id));
});

test("addToCart rejects any id NOT handed to the session (structural rule)", async () => {
  const sid = sessionId();
  const r = await dispatchTool("addToCart", {
    sessionId: sid,
    productId: "000000000000000000000000",
  });
  assert.equal(r.success, false);
  assert.equal(r.error, "invalid_product_reference");
});

test("addToCart is idempotent for an identical repeated add (no double-add)", async () => {
  const sid = sessionId();
  const item = await searchFirst(sid, { category: "Jewelry", maxPrice: 2000 });

  const add1 = await dispatchTool("addToCart", { sessionId: sid, productId: item.id });
  assert.equal(add1.success, true);

  const add2 = await dispatchTool("addToCart", { sessionId: sid, productId: item.id });
  assert.equal(add2.success, true);
  assert.equal(add2.data!.skipped, true, "identical repeat must be a no-op");

  const cart = await getStore().getCart(sid);
  const line = cart!.items.find((i) => i.productId === item.id)!;
  assert.equal(line.quantity, 1, "quantity must not double");

  // A deliberate increase with a different quantity merges rather than dupes.
  await dispatchTool("addToCart", { sessionId: sid, productId: item.id, quantity: 2 });
  const cart2 = await getStore().getCart(sid);
  const line2 = cart2!.items.find((i) => i.productId === item.id)!;
  assert.equal(line2.quantity, 3);
});

test("out-of-stock add returns a real in-stock alternative from the SAME category", async () => {
  const sid = sessionId();
  const outOfStock = (await getStore().allProducts()).find((p) => p.stock === 0);
  assert.ok(outOfStock);

  // Hand the id to the session via a targeted search that returns the product.
  const search = await dispatchTool("searchProducts", { sessionId: sid, q: outOfStock.name });
  const r = await dispatchTool("addToCart", { sessionId: sid, productId: outOfStock.id });
  assert.equal(r.success, false);
  assert.equal(r.error, "out_of_stock");
  const alt = r.data!.alternative as { id: string; stock: number; keySpecs: string[] };
  assert.ok(alt, "backend must propose an alternative");
  assert.ok(alt.stock > 0, "alternative must be in stock");
  const altProduct = await getStore().getProductById(alt.id);
  assert.equal(altProduct!.category, outOfStock.category, "alternative stays in the same category");
});

test("applyCoupon validates codes and updates cart totals", async () => {
  const sid = sessionId();
  const item = await searchFirst(sid, { category: "Jewelry", maxPrice: 2000 });
  await dispatchTool("addToCart", { sessionId: sid, productId: item.id });

  const bad = await dispatchTool("applyCoupon", { sessionId: sid, code: "NOTREAL" });
  assert.equal(bad.success, false);
  assert.equal(bad.error, "invalid_coupon");
  assert.ok((bad.data!.suggestions as Array<{ code: string }>).length > 0);

  const ok = await dispatchTool("applyCoupon", { sessionId: sid, code: "welcome15" });
  assert.equal(ok.success, true);
  const cart = (ok.data!.cart as { discountPercent: number; discount: number; subtotal: number });
  assert.equal(cart.discountPercent, 15);
  assert.equal(cart.discount, Math.round((cart.subtotal * 15) / 100));
});

test("checkout requires explicit confirmation before an order exists", async () => {
  const sid = sessionId();
  const item = await searchFirst(sid, { category: "Jewelry", maxPrice: 2000 });
  const added = await dispatchTool("addToCart", { sessionId: sid, productId: item.id });
  const subtotal = (added.data!.cart as { subtotal: number }).subtotal;
  const before = (await getStore().getProductById(item.id))!.stock;

  // Preview only — NO order created.
  const preview = await dispatchTool("checkout", { sessionId: sid });
  assert.equal(preview.success, true);
  assert.equal((preview.data as { confirmRequired: boolean }).confirmRequired, true);
  assert.equal(await getStore().getLatestOrder(sid), null, "no order before confirmation");

  // Confirm -> order created, cart cleared, stock decremented.
  const confirmed = await dispatchTool("checkout", { sessionId: sid, confirm: true });
  assert.equal(confirmed.success, true);
  assert.equal((confirmed.data as { orderConfirmed: boolean }).orderConfirmed, true);

  const order = await getStore().getLatestOrder(sid);
  assert.equal(order!.status, "confirmed");
  assert.equal(order!.items[0].productId, item.id);
  assert.equal(order!.total, subtotal);

  const cart = await getStore().getCart(sid);
  assert.equal(cart!.items.length, 0);
  const after = (await getStore().getProductById(item.id))!.stock;
  assert.equal(after, before - 1, "stock must decrement on confirmation");

  const again = await dispatchTool("checkout", { sessionId: sid, confirm: true });
  assert.equal(again.success, false);
  assert.equal(again.error, "empty_cart");
});

test("removeFromCart requires the item to actually be in the cart", async () => {
  const sid = sessionId();
  const item = await searchFirst(sid, { category: "Women's Clothing", maxPrice: 3000 });

  const miss = await dispatchTool("removeFromCart", { sessionId: sid, productId: item.id });
  assert.equal(miss.success, false);
  assert.equal(miss.error, "not_in_cart");

  await dispatchTool("addToCart", { sessionId: sid, productId: item.id });
  const hit = await dispatchTool("removeFromCart", { sessionId: sid, productId: item.id });
  assert.equal(hit.success, true);
  const cart = await getStore().getCart(sid);
  assert.equal(cart!.items.length, 0);
});

test("getProduct rejects ids outside the session (no recall from memory)", async () => {
  const sid = sessionId();
  const product = (await getStore().allProducts()).find((p) => p.category === "Jewelry")!;
  const r = await dispatchTool("getProduct", { sessionId: sid, productId: product.id });
  assert.equal(r.success, false);
  assert.equal(r.error, "invalid_product_reference");
});

test("searchProducts rejects categories outside the allowed four", async () => {
  const sid = sessionId();
  const r = await dispatchTool("searchProducts", { sessionId: sid, category: "Toys" });
  assert.equal(r.success, false);
  assert.equal(r.error, "invalid_category");
  assert.ok((r.message as string).includes("Electronics"));
});

test("search with impossible budget returns honest no_results", async () => {
  const sid = sessionId();
  const r = await dispatchTool("searchProducts", { sessionId: sid, category: "Electronics", maxPrice: 10 });
  assert.equal(r.success, false);
  assert.equal(r.error, "no_results");
});