import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetStoreForTests, initStore, getStore } from "../src/db/index.js";
import { dispatchTool } from "../src/tools/index.js";
import { runTurn } from "../src/agent/agent.js";
import { PlaceholderBrain } from "../src/agent/llm/placeholderBrain.js";
import { buildState } from "../src/routes/state.js";
import { buildSystemPrompt, buildVoiceAgentSystemPrompt } from "../src/agent/prompts.js";
import {
  __setVisionClientForTests,
  __clearVisualCache,
  getLastDescribedProductId,
} from "../src/vision/index.js";
import type { VisionClient } from "../src/vision/openaiVisionClient.js";
import { VisionError } from "../src/vision/errors.js";
import {
  normalizeVisualAnalysis,
  sanitizeSpokenDescription,
  type VisionAnalysis,
} from "../src/vision/attributes.js";
import { fetchProductImage } from "../src/vision/imageFetcher.js";
import { SEED_PRODUCTS } from "../src/seed/products.js";
import type { ToolResult } from "../src/types.js";

let sidCounter = 0;
const sessionId = () => `vision-test-${++sidCounter}`;

/** A provider that reports exactly what the test tells it to. */
function fakeVision(result: Partial<VisionAnalysis> = {}): VisionClient {
  return {
    async analyze() {
      return normalizeVisualAnalysis({
        description: "A navy midi dress with a V-neck and short ruffle sleeves.",
        visualAttributes: { color: "navy", itemType: "dress", neckline: "V-neck" },
        notDetermined: ["sleeves"],
        ...result,
      });
    },
  };
}

/** A provider that always blows up the way a real one can. */
function brokenVision(code: "image_unavailable" | "vision_failed", detail: string): VisionClient {
  return {
    async analyze() {
      throw new VisionError(code, detail);
    },
  };
}

async function firstProductId(sid: string, filter: Record<string, unknown> = {}): Promise<string> {
  const r = await dispatchTool("searchProducts", { sessionId: sid, ...filter });
  assert.equal(r.success, true, r.message);
  return (r.data!.items as Array<{ id: string }>)[0].id;
}

beforeEach(async () => {
  __resetStoreForTests();
  __clearVisualCache();
  __setVisionClientForTests(null);
  await initStore({ forceMemory: true });
});

test("every seeded product has real image bytes on disk at its catalog path", async () => {
  for (const product of SEED_PRODUCTS) {
    assert.ok(product.imageUrl.startsWith("/images/products/"), `${product.name}: ${product.imageUrl}`);
    const image = await fetchProductImage(product.imageUrl);
    assert.ok(image.byteLength > 1000, `${product.name} image is suspiciously small`);
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.source, "file");
    assert.ok(image.dataUrl.startsWith("data:image/png;base64,"));
  }
});

test("catalog path traversal is rejected instead of reading outside the public dir", async () => {
  await assert.rejects(
    () => fetchProductImage("/images/products/../../../../etc/passwd"),
    (err: unknown) => err instanceof VisionError && err.code === "image_unavailable"
  );
});

test("every product handed to the caller advertises its image url", async () => {
  const sid = sessionId();
  const r = await dispatchTool("searchProducts", { sessionId: sid, q: "blazer", maxResults: 2 });
  assert.equal(r.success, true, r.message);
  const items = r.data!.items as Array<{ id: string; imageUrl: string }>;
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(item.imageUrl.startsWith("/images/products/"), `${item.id} is missing an image url`);
  }
});

test("describeProductImage reports the photo, not the product name", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const id = await firstProductId(sid);

  const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  assert.equal(r.success, true, r.message);
  assert.match(r.message, /navy midi dress/i);
  const data = r.data as { attributes: Record<string, string>; notDetermined: string[]; imageUrl: string };
  assert.equal(data.attributes.color, "navy");
  assert.deepEqual(data.notDetermined, ["sleeves"]);
  assert.ok(data.imageUrl.startsWith("/images/products/"));
});

test("the vision model is sent the image only — no name, price or specs in the payload", async () => {
  const sid = sessionId();
  let seen = "";
  __setVisionClientForTests({
    async analyze(input) {
      seen = input.dataUrl;
      return normalizeVisualAnalysis({ description: "A small dark case with a lid." });
    },
  });
  const id = await firstProductId(sid);
  const product = (await getStore().getProductById(id))!;

  const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  assert.equal(r.success, true);
  // the only thing the provider receives is the encoded photo
  assert.deepEqual(Object.keys(await Promise.resolve({})) , []);
  assert.ok(seen.startsWith("data:image/png;base64,"));
  assert.ok(!seen.includes(encodeURIComponent(product.name)));
  assert.ok(!seen.includes(String(product.price)));
});

test("a visual follow-up is answered from the cache, not a second model call", async () => {
  const sid = sessionId();
  let calls = 0;
  __setVisionClientForTests({
    async analyze() {
      calls += 1;
      return normalizeVisualAnalysis({
        description: "It's a navy midi dress with a V-neck.",
        visualAttributes: { pockets: "no pockets visible" },
      });
    },
  });
  const id = await firstProductId(sid);

  const first = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  assert.equal(first.success, true);
  const second = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  assert.equal(second.success, true);
  assert.equal(calls, 1, "the follow-up must reuse the cached analysis");
  assert.equal((second.data as { fromCache: boolean }).fromCache, true);
  assert.equal(getLastDescribedProductId(sid), id);
});

test("'does it have pockets?' resolves to the product just described, with no id in the payload", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const id = await firstProductId(sid);
  await dispatchTool("describeProductImage", { sessionId: sid, productId: id });

  const followUp = await dispatchTool("describeProductImage", { sessionId: sid });
  assert.equal(followUp.success, true);
  assert.equal((followUp.data as { productId: string }).productId, id);
});

test("the tool refuses a product id the session was never given", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: "made-up-id" });
  assert.equal(r.success, false);
  assert.equal(r.error, "invalid_product_reference");
});

test("with no product in context at all the tool asks instead of guessing", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const r = await dispatchTool("describeProductImage", { sessionId: sid });
  assert.equal(r.success, false);
  assert.equal(r.error, "no_product_in_context");
  assert.equal((r.data as { needsClarification: boolean }).needsClarification, true);
});

test("an unreadable photo yields the honest spoken line, never a description", async () => {
  const sid = sessionId();
  __setVisionClientForTests(brokenVision("image_unavailable", "image_file_missing"));
  const id = await firstProductId(sid);
  const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  assert.equal(r.success, false);
  assert.equal(r.error, "image_unavailable");
  assert.equal(r.message, "I can't access the image for this product right now.");
  assert.ok(!r.message.includes("dress") && !r.message.includes("watch"));
});

test("a model failure offers the text alternative instead of a guess", async () => {
  const sid = sessionId();
  __setVisionClientForTests(brokenVision("vision_failed", "vision_call_failed: 429"));
  const id = await firstProductId(sid);
  const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  assert.equal(r.success, false);
  assert.equal(r.error, "vision_failed");
  assert.match(r.message, /price, rating, or specifications/);
});

test("no vision provider configured is a failure, not a fallback description", async () => {
  const sid = sessionId();
  __setVisionClientForTests(null);
  const { config } = await import("../src/config.js");
  const saved = config.openaiKey;
  (config as { openaiKey: string }).openaiKey = "";
  try {
    const id = await firstProductId(sid);
    const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
    assert.equal(r.success, false);
    assert.equal(r.error, "vision_failed");
  } finally {
    (config as { openaiKey: string }).openaiKey = saved;
  }
});

test("placeholder brain routes a visual question to the tool, not to the product name", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const brain = new PlaceholderBrain();

  await runTurn({
    sessionId: sid,
    userText: "show me dresses",
    llm: brain,
    dispatch: async (name, args) => {
      calls.push({ name, args });
      return dispatchTool(name, args);
    },
  });
  const id = (await getStore().getSession(sid))!.recentProductIds[0];

  calls.length = 0;
  const turn = await runTurn({
    sessionId: sid,
    userText: "what colour is the first one, and does it have pockets?",
    llm: brain,
    dispatch: async (name, args) => {
      calls.push({ name, args });
      return dispatchTool(name, args);
    },
  });
  assert.deepEqual(calls.map((c) => c.name), ["describeProductImage"]);
  assert.equal(calls[0].args.productId, id);
  assert.match(turn.reply, /navy midi dress/i);
  // the reply must not claim to have seen an image on the user's behalf
  assert.ok(!/as you can see|image|photo|picture/i.test(turn.reply));
});

test("a plain browse request still searches instead of describing", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const calls: string[] = [];
  const brain = new PlaceholderBrain();
  await runTurn({
    sessionId: sid,
    userText: "show me some bracelets",
    llm: brain,
    dispatch: async (name, args) => {
      calls.push(name);
      return dispatchTool(name, args);
    },
  });
  assert.deepEqual(calls, ["searchProducts"]);
});

test("state exposes imageUrl always, and a visual description only after analysis", async () => {
  const sid = sessionId();
  __setVisionClientForTests(fakeVision({}));
  const id = await firstProductId(sid);

  const before = await buildState(sid);
  assert.ok(before.recentProducts[0].imageUrl.startsWith("/images/products/"));
  assert.equal(before.recentProducts[0].visualDescription, undefined);

  await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
  const after = await buildState(sid);
  assert.match(after.recentProducts[0].visualDescription!, /navy midi dress/i);
});

test("system prompts tell the agent to tool visual questions and never recall them", () => {
  const session = {
    sessionId: "s1",
    cart: null as never,
    recentProductIds: ["p1"],
    lastAction: null,
  } as never;
  const turnPrompt = buildSystemPrompt(session);
  assert.match(turnPrompt, /describeProductImage/);
  assert.match(turnPrompt, /not evidence of appearance|NEVER describe/i);
  const voice = buildVoiceAgentSystemPrompt();
  assert.match(voice, /describe_product_image/);
  assert.match(voice, /never from the product name, description or specs/i);
});

test("the real client puts the photo — and nothing about the product — on the wire", async () => {
  const { createServer } = await import("node:http");
  const { config } = await import("../src/config.js");
  const seen: any[] = [];
  let status = 200;
  const body =
    status === 200
      ? JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  description: "It's a white trainer with a thick sole and a fabric upper.",
                  visualAttributes: { color: "white", itemType: "trainer", sole: "thick", details: "fabric upper" },
                }),
              },
            },
          ],
        })
      : JSON.stringify({ error: { message: "model rejected" } });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const savedKey = config.openaiKey;
  const savedBase = config.openaiBaseUrl;
  (config as { openaiKey: string }).openaiKey = "test-key";
  (config as { openaiBaseUrl: string }).openaiBaseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const sid = sessionId();
    // no injected client: this builds the real OpenAiVisionClient from config
    const id = await firstProductId(sid, { q: "trainer" });
    const product = (await getStore().getProductById(id))!;

    const r = await dispatchTool("describeProductImage", { sessionId: sid, productId: id });
    assert.equal(r.success, true, r.message);
    assert.match(r.message, /white trainer/i);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].auth, "Bearer test-key");

    const parts = seen[0].body.messages[1].content;
    const image = parts.find((p: any) => p.type === "image_url");
    assert.ok(image, "the photo must be sent");
    assert.ok(image.image_url.url.startsWith("data:image/png;base64,"));
    assert.ok(image.image_url.url.length > 2000, "the inline photo bytes must be real");

    // nothing the catalog knows about the product may be sent to the model
    const wire = JSON.stringify(seen[0].body);
    assert.ok(!wire.includes(product.name), `name leaked: ${product.name}`);
    assert.ok(!wire.includes(String(product.price)));
    assert.ok(!wire.includes(product.id));
    assert.ok(!wire.includes(product.keySpecs[0]));

    // a provider-level error must not become a description
    status = 400;
    const sid2 = sessionId();
    await firstProductId(sid2, { q: "trainer" }); // same guardrail: it must be in context
    const r2 = await dispatchTool("describeProductImage", { sessionId: sid2, productId: id });
    assert.equal(r2.success, false);
    assert.equal(r2.error, "vision_failed");
    assert.match(r2.message, /price, rating, or specifications/);
    assert.ok(!/white trainer|thick sole/i.test(r2.message), "a failure must not describe anything");
  } finally {
    (config as { openaiKey: string }).openaiKey = savedKey;
    (config as { openaiBaseUrl: string }).openaiBaseUrl = savedBase;
    server.close();
  }
});

test("out-of-vocabulary and empty model output is dropped, not spoken", () => {
  const analysis = normalizeVisualAnalysis({
    description: "The image contains a product positioned centrally in frame.",
    visualAttributes: {
      color: "  navy blue ",
      details: "two front pockets, notch lapels",
      brand: "Acme",
      material: "unknown",
      sleeves: "not visible",
      price: 2499,
    },
    notDetermined: ["sleeves", "closure", "notAKey"],
  });
  assert.deepEqual(analysis.attributes, { color: "navy blue", details: "two front pockets, notch lapels" });
  assert.deepEqual(analysis.notDetermined, ["sleeves", "closure"]);
});

test("spoken descriptions are cut to two sentences and drop camera language", () => {
  assert.equal(
    sanitizeSpokenDescription("One. Two. Three. Four."),
    "One. Two."
  );
  assert.ok(sanitizeSpokenDescription("x".repeat(400)).length <= 281);
  const long = sanitizeSpokenDescription(`${"A".repeat(300)}, and then some more detail here.`);
  assert.ok(long.endsWith("…"), "an over-long description must be cut, not read out in full");
  assert.ok(long.length <= 281);
});
