/**
 * Gemini-only end-to-end run of the REAL agent loop.
 *
 * Nothing is stubbed except the model itself: the real provider selection, the
 * real tool-calling loop, the real HTTP tool gateway and the real shopping tools
 * all execute. GEMINI_API_KEY is the only LLM credential present; OPENAI_API_KEY
 * is explicitly empty. How a product looks is answered from the appearance the
 * catalog already stores, so no image is ever sent.
 */
import { runTurn } from "../src/agent/agent.js";
import { initStore } from "../src/db/index.js";
import type { DispatchFn } from "../src/agent/agent.js";
import type { ToolResult } from "../src/types.js";

const ORIGIN = "http://127.0.0.1:4000";

interface SessionResponse {
  sessionId: string;
}

async function newSession(): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = (await res.json()) as SessionResponse;
  return data.sessionId;
}

const SCRIPT = [
  ["1. basic conversation", "Hello Echo."],
  ["2. product search", "Show me men's shirts under 2000 rupees."],
  ["3. tool calling (add to cart)", "Add the first one to my cart."],
  ["4. cart", "What's in my cart?"],
  ["5. product details", "Tell me the rating of the first shirt."],
  ["6. stored appearance", "How does the first shirt look?"],
  ["7. appearance follow-up: collar", "What kind of collar does it have?"],
  ["8. appearance follow-up: colour", "Is the color dark?"],
  ["9. appearance follow-up: sleeves", "Does it have long sleeves?"],
  ["10. search by appearance", "Show me something striped."],
  ["11. honest gap", "Does it come in red?"],
];

await initStore({ forceMemory: true });

const sid = await newSession();
console.log(`session=${sid}\n`);

const dispatchFn: DispatchFn = async (name, params) => {
  const res = await fetch(`${ORIGIN}/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  return (await res.json()) as ToolResult;
};

for (const [label, text] of SCRIPT) {
  const tools: string[] = [];
  const r = await runTurn({
    sessionId: sid,
    userText: text,
    dispatch: dispatchFn,
    onToolCall: ({ name }) => {
      tools.push(name);
    },
  });
  console.log(`${label}`);
  console.log(`   ask     : ${text}`);
  console.log(`   tools   : ${tools.length ? tools.join(" -> ") : "(none)"}`);
  console.log(`   reply   : ${r.reply}`);
  console.log("");
}

// The stored appearance must reach the UI for every product mentioned, and no
// image field may exist anywhere in the payload.
const stateRes = await fetch(`${ORIGIN}/api/state/${sid}`);
const state = (await stateRes.json()) as {
  recentProducts?: Array<{ name: string; appearance?: { summary?: string } }>;
};
console.log("appearance carried to the UI:", JSON.stringify(
  (state.recentProducts ?? []).map((p) => ({ name: p.name, appearance: p.appearance?.summary ?? null }))
));
console.log("any image field in state:", JSON.stringify(state).match(/imageUrl|visualDescription/i) ? "YES (regression)" : "no");

const capsRes = await fetch(`${ORIGIN}/api/capabilities`);
const caps = await capsRes.json();
console.log("capabilities:", JSON.stringify(caps));