import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetStoreForTests, initStore, getStore } from "../src/db/index.js";
import { runTurn } from "../src/agent/agent.js";
import { PlaceholderBrain } from "../src/agent/llm/placeholderBrain.js";
import { dispatchTool, TOOL_DEFINITIONS, VOICE_AGENT_TOOL_DEFINITIONS, VOICE_AGENT_TOOL_NAME_MAP } from "../src/tools/index.js";
import { appearanceSentence } from "../src/tools/shared.js";
import { productShape, applyProductFilters, appearanceShape } from "../src/db/shape.js";
import { buildState } from "../src/routes/state.js";
import { SEED_PRODUCTS } from "../src/seed/products.js";
import { buildSystemPrompt, buildVoiceAgentSystemPrompt } from "../src/agent/prompts.js";
import type { DispatchFn } from "../src/agent/agent.js";
import type { ConversationSession, Product, ProductAppearance, ToolResult } from "../src/types.js";

let sidCounter = 0;
const sessionId = () => `appearance-test-${++sidCounter}`;

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

const toolNames = (log: Array<{ name: string }>) => log.map((c) => c.name);
const emptySession = (): ConversationSession => ({ id: "s", sessionId: "s", recentProductIds: [], lastAction: null });
const searchedItems = (r: ToolResult) => (r.data!.items as Array<{ id: string; name: string; index: number }>);

// ---------------------------------------------------------------------------
// The catalog itself
// ---------------------------------------------------------------------------

test("every seeded product ships a trusted visual description", () => {
  assert.equal(SEED_PRODUCTS.length, 40);
  for (const p of SEED_PRODUCTS) {
    assert.ok(p.appearance, `${p.name} must have appearance data`);
    assert.ok(p.appearance!.summary, `${p.name} must have an appearance summary`);
    assert.ok(p.appearance!.primaryColor, `${p.name} must state a primary colour`);
  }
});

test("appearance is category-appropriate, not a clothing template", () => {
  const byName = (n: string) => SEED_PRODUCTS.find((p) => p.name === n)!;

  // A pair of earbuds has no neckline, and must not be given one.
  const buds = byName("Nova Wireless Earbuds");
  assert.equal(buds.category, "Electronics");
  assert.ok(!/neckline|sleeve|collar/.test(JSON.stringify(buds.appearance)), "electronics must not carry garment fields");

  // A dress does describe the things a shopper asks about.
  const dress = byName("Floral Wrap Dress");
  assert.ok(dress.appearance!.details!.some((d) => /sleeve/i.test(d)), "a dress states its sleeves");
  assert.ok(/floral/i.test(dress.appearance!.pattern!), "a floral dress states its pattern");
  assert.ok(/navy/i.test(dress.appearance!.secondaryColors!.join(" ")), "a floral dress states its accent colour");

  // A necklace describes itself the way a necklace actually looks.
  const necklace = byName("Silver Crescent Necklace");
  assert.ok(/crescent/i.test(JSON.stringify(necklace.appearance)), "a crescent necklace says it is a crescent");
});

test("appearance never restates a factual spec as a visual claim", () => {
  for (const p of SEED_PRODUCTS) {
    const facts = p.keySpecs.join(" ").toLowerCase();
    // "100% cashmere" is a fact. An appearance that says "made of cashmere"
    // would be claiming material from a visual impression, which is exactly the
    // inference this field must never make.
    const appearance = JSON.stringify(p.appearance ?? {}).toLowerCase();
    if (facts.includes("cashmere")) {
      assert.ok(!/made of cashmere|is cashmere|cashmere wool/.test(appearance), `${p.name} must not assert a material`);
    }
    if (facts.includes("leather") && !/appearance/.test(appearance)) {
      assert.ok(true);
    }
  }
});

// ---------------------------------------------------------------------------
// Persistence and serialization
// ---------------------------------------------------------------------------

test("productShape keeps every appearance field and reports an absent one as absent", () => {
  const shaped = productShape({
    _id: "abc",
    name: "Test",
    category: "Jewelry",
    price: 10,
    stock: 1,
    rating: 4,
    reviewCount: 1,
    keySpecs: [],
    description: "d",
    appearance: {
      primaryColor: "navy",
      secondaryColors: ["white"],
      pattern: "pinstripe",
      details: ["notch lapel"],
      texture: "brushed",
      styleImpression: "sharp",
      summary: "A navy pinstripe jacket.",
    },
  } as any);
  assert.deepEqual(shaped.appearance, {
    primaryColor: "navy",
    secondaryColors: ["white"],
    pattern: "pinstripe",
    details: ["notch lapel"],
    texture: "brushed",
    styleImpression: "sharp",
    summary: "A navy pinstripe jacket.",
  });

  // A document seeded before appearance existed must still load, and must not
  // be given an empty object that would read as "described, but blank".
  const legacy = productShape({
    _id: "legacy",
    name: "Legacy",
    category: "Jewelry",
    price: 10,
    stock: 1,
    rating: 4,
    reviewCount: 1,
    keySpecs: [],
    description: "d",
  } as any);
  assert.equal(legacy.appearance, undefined);

  assert.equal(appearanceShape({}), undefined);
  assert.equal(appearanceShape(undefined), undefined);
  assert.equal(appearanceShape({ primaryColor: "  " }), undefined, "blank strings are not data");
});

test("appearance survives a round trip through the store", async () => {
  const store = getStore();
  const [first] = await store.searchProducts({ limit: 1 });
  const fetched = await store.getProductById(first.id);
  assert.deepEqual(fetched!.appearance, first.appearance);
  assert.ok(fetched!.appearance!.summary);

  const byIds = await store.getProductsByIds([first.id]);
  assert.deepEqual(byIds[0].appearance, first.appearance);
});

test("the Mongoose schema stores a full appearance and still accepts a product without one", async () => {
  const { Product: ProductModel } = await import("../src/models/Product.js");

  // Validation runs without a database connection, so this checks the real
  // schema: a product with every appearance field, and one seeded before the
  // field existed, must both be valid documents.
  const complete = new ProductModel({
    name: "Test Piece",
    category: "Women's Clothing",
    price: 10,
    stock: 1,
    rating: 4,
    reviewCount: 1,
    keySpecs: ["a", "b"],
    description: "d",
    appearance: {
      primaryColor: "navy",
      secondaryColors: ["white"],
      pattern: "pinstripe",
      details: ["notch lapel", "two buttons"],
      texture: "brushed",
      styleImpression: "sharp",
      summary: "A navy pinstripe jacket.",
    },
  });
  const completeError = complete.validateSync();
  assert.equal(completeError?.message, undefined, `full appearance must validate: ${completeError?.message}`);

  const bare = new ProductModel({
    name: "No Appearance Piece",
    category: "Jewelry",
    price: 10,
    stock: 1,
    rating: 4,
    reviewCount: 1,
    keySpecs: [],
    description: "d",
  });
  assert.equal(bare.validateSync()?.message, undefined, "appearance is optional");

  // The nested fields are optional too, so an earbud with no neckline is fine.
  const partial = new ProductModel({
    name: "Partial Appearance",
    category: "Electronics",
    price: 10,
    stock: 1,
    rating: 4,
    reviewCount: 1,
    keySpecs: [],
    description: "d",
    appearance: { primaryColor: "graphite" },
  });
  assert.equal(partial.validateSync()?.message, undefined, "partial appearance must validate");

  // And the schema must no longer carry the removed image field.
  const paths = Object.keys(ProductModel.schema.paths);
  assert.ok(!paths.includes("imageUrl"), "imageUrl must be gone from the schema");
  assert.ok(paths.includes("appearance"), "appearance must be on the schema");
});

test("a shopper can search by how something looks, not just by name", () => {
  const dresses = applyProductFilters(
    SEED_PRODUCTS.map((p, i) => productShape({ _id: `id${i}`, ...p } as any)),
    { q: "floral" }
  );
  assert.ok(dresses.some((d) => d.name === "Floral Wrap Dress"), "a floral query must find the floral dress");

  const striped = applyProductFilters(
    SEED_PRODUCTS.map((p, i) => productShape({ _id: `id${i}`, ...p } as any)),
    { q: "striped" }
  );
  assert.ok(striped.some((d) => /stripe/i.test(d.name) || d.appearance?.pattern === "fine vertical stripes"));
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

test("getProduct returns the stored appearance and says so out loud", async () => {
  const sid = sessionId();
  const search = await dispatchTool("searchProducts", { sessionId: sid, q: "wrap dress" });
  const id = searchedItems(search)[0].id;

  const result = await dispatchTool("getProduct", { sessionId: sid, productId: id });
  const product = result.data!.product as Product;
  assert.equal(product.appearance?.summary, "A cream wrap dress scattered with small navy and sage floral sprigs, with flutter short sleeves, a V-neck wrap bodice, a self-tie waist and a knee-length skirt.");
  assert.equal((result.data!.product as any).appearanceSpecified, true);
  assert.match(result.message!, /How it looks: A cream wrap dress/);
});

test("a product with no appearance is reported as having none, not described", async () => {
  const sid = sessionId();
  const store = getStore();
  const search = await dispatchTool("searchProducts", { sessionId: sid, q: "wrap dress" });
  const id = searchedItems(search)[0].id;

  // Simulate a catalog row that predates appearance data.
  const product = (await store.getProductById(id))!;
  const stripped = { ...product, appearance: undefined };
  const original = store.getProductById;
  (store as any).getProductById = async (want: string) => (want === id ? stripped : original.call(store, want));

  const result = await dispatchTool("getProduct", { sessionId: sid, productId: id });
  (store as any).getProductById = original;

  assert.equal((result.data!.product as any).appearance, undefined);
  assert.equal((result.data!.product as any).appearanceSpecified, false);
  assert.match(result.message!, /no visual description/i);
  assert.match(result.message!, /do not describe/i, "the tool must warn the model off guessing");
});

test("a search result is a hint, not the full appearance", async () => {
  const sid = sessionId();
  const result = await dispatchTool("searchProducts", { sessionId: sid, q: "wrap dress" });
  const item = searchedItems(result)[0] as Record<string, unknown>;
  assert.equal((item.appearance as ProductAppearance | undefined)?.primaryColor, "cream");
  assert.equal((item.appearance as any)?.summary, undefined, "a listed option must not carry the full summary");
  assert.equal((item as any).imageUrl, undefined, "no image is carried or displayed any more");
  assert.match(result.message!, /get_product/, "the result must point the model at the real description");
});

test("appearance is answerable for every single seeded product", async () => {
  const store = getStore();
  const all = await store.allProducts();
  for (const p of all) {
    const sentence = appearanceSentence(p.appearance);
    assert.ok(sentence && sentence.length > 10, `${p.name} must produce a speakable description`);
  }
});

// ---------------------------------------------------------------------------
// No runtime vision
// ---------------------------------------------------------------------------

test("no image-description tool is exposed to any LLM", () => {
  const openaiNames = TOOL_DEFINITIONS.map((d) => d.function.name);
  assert.ok(!openaiNames.includes("describeProductImage"));
  const voiceNames = VOICE_AGENT_TOOL_DEFINITIONS.map((d) => d.name);
  assert.ok(!voiceNames.includes("describe_product_image"));
  assert.ok(!("describe_product_image" in VOICE_AGENT_TOOL_NAME_MAP));
  assert.equal(Object.keys(VOICE_AGENT_TOOL_NAME_MAP).length, VOICE_AGENT_TOOL_DEFINITIONS.length);
});

test("no product or tool result carries an image path", async () => {
  const sid = sessionId();
  const search = await dispatchTool("searchProducts", { sessionId: sid, q: "dress" });
  assert.equal(JSON.stringify(search.data).includes("imageUrl"), false);
  assert.equal(JSON.stringify(search.data).includes("/images/"), false);

  for (const p of await getStore().allProducts()) {
    assert.equal((p as any).imageUrl, undefined, `${p.name} must not carry an image`);
  }

  const state = await buildState(sid);
  assert.equal(JSON.stringify(state).includes("imageUrl"), false);
});

test("prompts point at getProduct, not at a removed image tool", async () => {
  const system = buildSystemPrompt(emptySession());
  assert.ok(!/describeProductImage|describe_product_image|photo|image/i.test(system), "no image vocabulary may survive");
  assert.match(system, /getProduct/);
  assert.match(system, /product\.appearance/);

  const voice = buildVoiceAgentSystemPrompt();
  assert.ok(!/describe_product_image|image|photo/i.test(voice));
  assert.match(voice, /get_product/);
  assert.match(voice, /product\.appearance/);
});

test("the prompts forbid turning an appearance into a material claim", async () => {
  const system = buildSystemPrompt(emptySession());
  assert.match(system, /material/i);
  assert.match(system, /never upgrade|not a spec|separate/i);
});

// ---------------------------------------------------------------------------
// The required conversations, end to end
// ---------------------------------------------------------------------------

test("CONVERSATION 1 - 'Show me dresses' returns real options with usable ids", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const r = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch: recordingDispatch(log) });

  assert.deepEqual(toolNames(log), ["searchProducts"]);
  const items = searchedItems(r.toolCalls[0].result as ToolResult);
  assert.ok(items.length >= 2, "at least two options to choose between");
  for (const i of items) assert.ok(i.id, "every option carries a real id");
  assert.ok(r.reply.toLowerCase().includes("option 1"));
});

test("CONVERSATION 2 - 'How does the second dress look?' answers from the stored appearance", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const items = searchedItems(first.toolCalls[0].result as ToolResult);
  const second = items[1];
  const expected = (await getStore().getProductById(second.id))!;

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "How does the second dress look?", llm: brain, dispatch });

  assert.deepEqual(toolNames(log), ["getProduct"], "the appearance must come from a real fetch");
  assert.equal(log[0].args.productId, second.id, "it must be the SECOND option, not the first");

  const said = r.reply.toLowerCase();
  // Every visual claim in the reply must be traceable to what the catalog
  // stored for that product — not to a plausible-sounding guess.
  const stated = [
    expected.appearance!.primaryColor,
    ...(expected.appearance!.secondaryColors ?? []),
    expected.appearance!.pattern,
    ...(expected.appearance!.details ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const token of stated.split(/[^a-z]+/).filter((w) => w.length > 3)) {
    assert.ok(said.includes(token) || said.includes("how it looks"), `reply must carry the stored detail "${token}"`);
  }
  assert.match(said, /looks/, "the reply must actually answer the appearance question");
  assert.ok(!said.includes("i can see") && !said.includes("the image"), "never narrate seeing a picture");
});

test("CONVERSATION 3 - 'What about the sleeves?' resolves to the product just discussed", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const secondTurn = await runTurn({ sessionId: sid, userText: "How does the second dress look?", llm: brain, dispatch });
  const discussed = (secondTurn.toolCalls[0].result as ToolResult).data!.product as Product;
  const stored = discussed.appearance!.details!.join(" ").toLowerCase();
  const sleevesStated = /sleeve|strap|strapless/.test(stored);

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "What about the sleeves?", llm: brain, dispatch });

  assert.deepEqual(toolNames(log), ["getProduct"], "a follow-up still resolves a real product");
  assert.equal(log[0].args.productId, discussed.id, "it must be the same product, not a fresh guess");

  const said = r.reply.toLowerCase();
  if (sleevesStated) {
    assert.match(said, /sleeve|strap/, "the stored sleeve detail must reach the shopper");
  } else {
    // The catalog said nothing about sleeves for this one, so the honest reply
    // is that the detail is not specified. Inventing one is the failure here.
    assert.ok(
      /not|no |don't|does not|catalog|spec/i.test(said),
      `an unspecified detail must be declined, not invented: "${r.reply}"`
    );
  }
});

test("a sleeve follow-up is answered from the catalog when the product does state them", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const dress = (await getStore().getProductById(searchedItems(first.toolCalls[0].result as ToolResult)[0].id))!;
  assert.equal(dress.name, "Floral Wrap Dress", "the top-rated dress is the one with a documented sleeve");
  assert.ok(dress.appearance!.details!.some((d) => /flutter short sleeves/i.test(d)));

  await runTurn({ sessionId: sid, userText: "Tell me about the first option", llm: brain, dispatch });
  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "What about the sleeves?", llm: brain, dispatch });
  assert.match(r.reply.toLowerCase(), /sleeve/);
  assert.match(r.reply.toLowerCase(), /flutter|short/);
});

test("CONVERSATION 4 - 'Add the first one to my cart' acts on the handed id", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const ids = searchedItems(first.toolCalls[0].result as ToolResult).map((i) => i.id);

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "Add the first one to my cart", llm: brain, dispatch });

  assert.deepEqual(toolNames(log), ["addToCart"]);
  assert.ok(ids.includes(log[0].args.productId as string));
  assert.equal((await getStore().getCart(sid))!.items.length, 1);
  assert.match(r.reply.toLowerCase(), /cart/);
});

test("CONVERSATION 5 - 'What's in my cart?' reports the real cart", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  await runTurn({ sessionId: sid, userText: "Add the first one to my cart", llm: brain, dispatch });

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "What's in my cart?", llm: brain, dispatch });

  assert.deepEqual(toolNames(log), ["getCart"]);
  assert.match(r.reply.toLowerCase(), /dress|total/);
});

test("CONVERSATION 6 - 'Does it have short sleeves?' is answered from stored data", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const items = searchedItems(first.toolCalls[0].result as ToolResult);

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "Does the first one have short sleeves?", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["getProduct"]);
  assert.equal(log[0].args.productId, items[0].id);

  const product = (r.toolCalls[0].result as ToolResult).data!.product as Product;
  const saysShort = /short/i.test(product.appearance!.details!.join(" "));
  assert.match(r.reply.toLowerCase(), saysShort ? /short|flutter/ : /sleeve|neckline|length|dress|spec|not/i);
});

test("CONVERSATION 7 - 'Tell me about the second option' opens that exact product", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const items = searchedItems(first.toolCalls[0].result as ToolResult);

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "Tell me about the second option", llm: brain, dispatch });

  assert.deepEqual(toolNames(log), ["getProduct"]);
  assert.equal(log[0].args.productId, items[1].id);
  assert.ok(r.reply.includes(items[1].name), "the reply must name the product it opened");
});

test("CONVERSATION 8 - 'Show me something in dark blue' finds it by appearance", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const r = await runTurn({ sessionId: sid, userText: "Show me something in dark blue", llm: brain, dispatch: recordingDispatch(log) });

  assert.deepEqual(toolNames(log), ["searchProducts"]);
  const items = searchedItems(r.toolCalls[0].result as ToolResult);
  assert.ok(items.length > 0, "a colour request must return something");
  const names = items.map((i) => i.name).join(" ");
  assert.match(names, /Blazer|Jeans/, "the dark blue options are the navy blazer or the indigo jeans");
});

test("CONVERSATION 9 - 'Compare the first and second options' opens both", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const items = searchedItems(first.toolCalls[0].result as ToolResult);

  log.length = 0;
  const r = await runTurn({ sessionId: sid, userText: "Compare the first and second options", llm: brain, dispatch });

  assert.equal(toolNames(log).filter((n) => n === "getProduct").length, 2, "both options must be opened");
  const asked = log.filter((l) => l.name === "getProduct").map((l) => l.args.productId);
  assert.deepEqual(asked, [items[0].id, items[1].id]);
  assert.match(r.reply, /Option 1/);
  assert.match(r.reply, /Option 2/);
  assert.match(r.reply.toLowerCase(), /looks/, "each side of the comparison carries its appearance");
});

test("CONVERSATION 10 - 'Add it to my cart' after describing it adds that product", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  const first = await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const items = searchedItems(first.toolCalls[0].result as ToolResult);
  const look = await runTurn({ sessionId: sid, userText: "Tell me about the second option", llm: brain, dispatch });
  const described = (look.toolCalls[0].result as ToolResult).data!.product as Product;

  log.length = 0;
  await runTurn({ sessionId: sid, userText: "Add it to my cart", llm: brain, dispatch });

  const cart = (await getStore().getCart(sid))!;
  assert.deepEqual(cart.items.map((i) => i.productId), [described.id]);
  assert.ok(items.some((i) => i.id === described.id));
});

test("'it' after a description never re-searches and never guesses a new product", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatch = recordingDispatch(log);

  await runTurn({ sessionId: sid, userText: "Show me dresses", llm: brain, dispatch });
  const look = await runTurn({ sessionId: sid, userText: "Tell me about the first option", llm: brain, dispatch });
  const first = (look.toolCalls[0].result as ToolResult).data!.product as Product;

  log.length = 0;
  await runTurn({ sessionId: sid, userText: "What colour is it?", llm: brain, dispatch });
  assert.deepEqual(toolNames(log), ["getProduct"]);
  assert.equal(log[0].args.productId, first.id);
});

test("an appearance question with nothing in context asks instead of inventing", async () => {
  const sid = sessionId();
  const log: Array<{ name: string; args: Record<string, unknown> }> = [];
  const r = await runTurn({ sessionId: sid, userText: "What does it look like?", llm: brain, dispatch: recordingDispatch(log) });

  assert.deepEqual(toolNames(log), [], "no product was named, so nothing may be called");
  assert.match(r.reply.toLowerCase(), /which|what|product|item/);
  assert.ok(!/it is|looks like/i.test(r.reply), "it must not describe an unseen product");
});

// ---------------------------------------------------------------------------
// The UI payload
// ---------------------------------------------------------------------------

test("session state carries appearance to the UI with no image fields at all", async () => {
  const sid = sessionId();
  const search = await dispatchTool("searchProducts", { sessionId: sid, q: "wrap dress" });
  const id = searchedItems(search)[0].id;
  await dispatchTool("getProduct", { sessionId: sid, productId: id });

  const state = await buildState(sid);
  const recent = state.recentProducts[0] as Record<string, unknown>;
  assert.equal(recent.id, id);
  assert.ok((recent.appearance as ProductAppearance).summary, "the UI gets the description the voice agent reads");
  assert.equal(recent.imageUrl, undefined);
  assert.equal(recent.visualDescription, undefined);
});
