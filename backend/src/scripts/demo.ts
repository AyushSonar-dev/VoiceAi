import { initStore, __resetStoreForTests, getMode } from "../db/index.js";
import { startServer } from "../index.js";
import { runTurn } from "../agent/agent.js";
import { config } from "../config.js";
import type { Server } from "node:http";

/**
 * Keyless end-to-end demo: runs the real tool gateway over HTTP and the real
 * tool-use loop, driven by the clearly-marked PLACEHOLDER brain (no LLM key
 * needed). Set OPENAI_API_KEY to have the loop driven by the real model instead.
 */
async function main(): Promise<void> {
  __resetStoreForTests();
  await initStore({ forceMemory: true });

  const server = await startServer({ port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`\n[ECHOLABS] DEMO session (memory store, placeholder brain)`);
  console.log(`[ECHOLABS] Brain mode: ${getMode()?.toUpperCase()} store, driver below\n`);

  const sessionRes = await fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST" });
  const { sessionId } = (await sessionRes.json()) as { sessionId: string };

  const lines = [
    "find me bracelets",
    "add the first one to my cart",
    "add the second one to my cart",
    "what's in my cart",
    "apply WELCOME15",
    "check out",
    "yes, place the order",
  ];

  const gatewayUrl = `http://127.0.0.1:${port}`;

  for (const line of lines) {
    const userLine = line.startsWith("yes") ? "[user confirms]" : "";
    console.log(`\nUSER: ${line}`);
    if (userLine) console.log(`       (${userLine})`);
    const result = await runTurn({ sessionId, userText: line, gatewayUrl });
    console.log(`ECHO: ${result.reply}`);
    if (result.toolCalls.length) {
      console.log(
        `  -> tools called: ${result.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(", ")}`
      );
    }
  }

  const state = (await fetch(`http://127.0.0.1:${port}/api/state/${sessionId}`).then((r) => r.json())) as {
    cart?: { isEmpty?: boolean; linesText?: string };
    lastOrder?: { id?: string; total?: number; status?: string };
  };
  console.log(`\n[ECHOLABS] Final cart lines: ${state.cart?.isEmpty ? "(empty)" : state.cart?.linesText}`);
  console.log(
    `[ECHOLABS] Last order: ${state.lastOrder ? `#${state.lastOrder.id} total ${state.lastOrder.total} status ${state.lastOrder.status}` : "none"}`
  );

  console.log(`\n[ECHOLABS] Demo ended cleanly. Set keys in .env for the full voice stack.`);
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[ECHOLABS] demo failed:", err);
  process.exit(1);
});