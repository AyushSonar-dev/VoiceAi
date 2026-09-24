import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetStoreForTests, initStore, getStore } from "../src/db/index.js";
import { runTurn } from "../src/agent/agent.js";
import { PlaceholderBrain } from "../src/agent/llm/placeholderBrain.js";
import { dispatchTool } from "../src/tools/index.js";
import type { DispatchFn } from "../src/agent/agent.js";
import type { ToolResult } from "../src/types.js";

let sidCounter = 0;
const sessionId = () => `loop-test-${++sidCounter}`;

const brain = new PlaceholderBrain();

beforeEach(async () => {
  __resetStoreForTests();
  await initStore({ forceMemory: true });
});

function recordingDispatch(log: Array<{ name: string; args: Record<string, unknown> }>): DispatchFn {
  return async (name, args) => {
    log.push({ name, args });
    return dispatchTool(name, args);
  };
}

const toolNames = (log: Array<{ name: string; args: Record<string, unknown> }>) => log.map((c) => c.name);

test("search then 'the first/second one': loop only ever acts on handed ids", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const r1 = await runTurn({ sessionId: sid, userText: "find me bracelets", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["searchProducts"]);
  const ids = ((r1.toolCalls[0].result as ToolResult).data!.items as Array<{ id: string }>).map((i) => i.id);
  assert.equal(ids.length, 2, "bracelets search should hand us exactly 2 ids");
  assert.ok(r1.reply.toLowerCase().includes("option 1"));

  log.length = 0;
  const r2 = await runTurn({ sessionId: sid, userText: "add the first one to my cart", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["addToCart"]);
  assert.ok(ids.includes(log[0].args.productId as string));
  assert.ok(r2.reply.toLowerCase().includes("cart"));

  log.length = 0;
  const r3 = await runTurn({ sessionId: sid, userText: "add the second one to my cart", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["addToCart"]);
  assert.ok(ids.includes(log[0].args.productId as string));
  const cart = await getStore().getCart(sid);
  assert.equal(cart!.items.length, 2);
});

test("loop reflects a backend failure truthfully (no fabricated success)", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  await runTurn({ sessionId: sid, userText: "show me the vision 4k tv stick", llm: brain, dispatch });
  const r2 = await runTurn({ sessionId: sid, userText: "add the first one to my cart", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["searchProducts", "addToCart"]);
  assert.equal(((await getStore().getCart(sid)) as { items: unknown[] }).items.length, 0, "nothing was added on a failed add");
  assert.ok(/out of stock|outofstock/i.test(r2.reply), `reply must state the failure: "${r2.reply}"`);
  assert.ok(!r2.reply.toLowerCase().includes("added"), "must not claim the item was added");
});

test("loop asks for clarity before touching the cart when nothing was handed yet", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const r = await runTurn({ sessionId: sid, userText: "add the second one to my cart", llm: brain, dispatch });
  assert.equal(log.length, 0, "no cart mutation allowed without a handed id");
  assert.ok(/guess|search/i.test(r.reply));
});

test("checkout preview -> confirmation creates the order only after 'yes'", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  await runTurn({ sessionId: sid, userText: "find me bracelets", llm: brain, dispatch });
  log.length = 0;
  await runTurn({ sessionId: sid, userText: "add the first one to my cart", llm: brain, dispatch });

  log.length = 0;
  const preview = await runTurn({ sessionId: sid, userText: "check out", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["checkout"]);
  assert.notEqual((preview.toolCalls[0].args as { confirm?: boolean }).confirm, true);
  assert.equal(await getStore().getLatestOrder(sid), null, "preview must not create an order");

  log.length = 0;
  const confirmTurn = await runTurn({ sessionId: sid, userText: "yes, place the order", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["checkout"]);
  assert.equal((confirmTurn.toolCalls[0].args as { confirm: boolean }).confirm, true);
  const order = await getStore().getLatestOrder(sid);
  assert.ok(order);
  assert.equal(order.status, "confirmed");
  assert.ok(confirmTurn.reply.toLowerCase().includes("confirmed"));
  assert.ok(confirmTurn.reply.length > 20);
});

test("loop over the real HTTP tool gateway (end-to-end wiring)", async () => {
  const { startServer } = await import("../src/index.js");
  const server = await startServer({ port: 0 });
  const port = (server.address() as { port: number }).port;
  try {
    const sid = sessionId();
    const r = await runTurn({
      sessionId: sid,
      userText: "find me bracelets",
      llm: brain,
      gatewayUrl: `http://127.0.0.1:${port}/api/tools`,
    });
    assert.ok(r.reply.toLowerCase().includes("option 1"));

    const state = (await fetch(`http://127.0.0.1:${port}/api/state/${sid}`).then((res) =>
      res.json()
    )) as { recentProducts: unknown[]; sessionId: string };
    assert.ok(Array.isArray(state.recentProducts) && state.recentProducts.length >= 1);
    assert.equal(state.sessionId, sid);
  } finally {
    server.close();
  }
});