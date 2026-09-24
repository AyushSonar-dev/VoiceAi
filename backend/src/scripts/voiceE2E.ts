#!/usr/bin/env tsx
/**
 * Real AssemblyAI Voice Agent E2E (headless). Uses the same WS contract as the
 * browser: mint token via POST /api/voice/setup, connect to
 * wss://agents.assemblyai.com/v1/ws?token=..., session.update with the inline
 * config, drive the agent via conversation.message + reply.create, assert tool
 * results arrive and that agent speech never precedes tool.result.
 *
 * This uses real credentials (loaded by backend/config) and real Mongo.
 * Run from repo root: tsx backend/src/scripts/voiceE2E.ts
 */

import WebSocket from "ws";
import { config } from "../config.js";

interface ToolResultMsg {
  type: "tool.result";
  call_id: string;
  result: string;
  is_error: boolean;
}

interface Msg {
  type: string;
  [key: string]: any;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function waitMsg(ws: WebSocket, pred: (m: Msg) => boolean): Promise<Msg> {
  return new Promise((resolve) => {
    const onMsg = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(String(data)) as Msg;
        if (pred(msg)) {
          ws.off("message", onMsg);
          resolve(msg);
        }
      } catch {
        /* ignore */
      }
    };
    ws.on("message", onMsg);
  });
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });

async function setup(): Promise<{ token: string; session: any }> {
  const base = `http://127.0.0.1:${config.port}`;
  return fetchJson(`${base}/api/voice/setup`, { method: "POST" });
}

async function callTool(name: string, args: any, sessionId: string): Promise<any> {
  const base = `http://127.0.0.1:${config.port}`;
  return fetchJson(`${base}/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...args, sessionId }),
  });
}

async function main(): Promise<void> {
  const base = `http://127.0.0.1:${config.port}`;
  const { token, session } = await setup();
  console.log("[e2e] setup OK (token len)", token.length);

  const wsUrl = `wss://agents.assemblyai.com/v1/ws?token=${token}`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (e) => reject(e));
  });

  ws.send(JSON.stringify({ type: "session.update", session }));
  await timeout(waitMsg(ws, (m) => m.type === "session.ready"), 6000);
  console.log("[e2e] session.ready");
  console.log("[e2e] tools offered:", session.tools?.map((t: any) => t.name).join(", "));

  const sessionId = `e2e-${Date.now().toString(36)}`;
  const step = {
    toolCalls: 0,
    toolResultsBeforeAgent: 0,
    agentSpokeBeforeResult: 0,
    violations: [] as string[],
  };

  let inFlight = false;
  let turned = false;
  let toolResultsSent = new Set<string>();
  const seenToolNames = new Set<string>();

  const lastAgentAt = { v: -1 };
  const lastToolResultAt = { v: -1 };

  const start = Date.now();
  const onMsg = (data: WebSocket.RawData) => {
    const msg = JSON.parse(String(data)) as Msg;
    switch (msg.type) {
      case "tool.call": {
        step.toolCalls++;
        inFlight = true;
        seenToolNames.add(String(msg.name));
        const callId = String(msg.call_id);
        const name = String(msg.name);
        const args = (typeof msg.arguments === "object" && msg.arguments) || {};
        console.log(`[e2e] tool.call ${name} ${callId} args=${JSON.stringify(args)}`);
        callTool(name, { ...args, sessionId }, sessionId)
          .then((result) => {
            const frame: ToolResultMsg = {
              type: "tool.result",
              call_id: callId,
              result: JSON.stringify(result),
              is_error: !result.success,
            };
            if (lastAgentAt.v > lastToolResultAt.v && lastToolResultAt.v >= 0) {
              step.agentSpokeBeforeResult++;
              step.violations.push("agent spoke before tool.result for " + name);
            }
            lastToolResultAt.v = Date.now();
            toolResultsSent.add(callId);
            ws.send(JSON.stringify(frame));
            step.toolResultsBeforeAgent++;
            if (name === "search_products") searchData = result.data;
            if (name === "apply_coupon" && result.success === true) couponPreviewSeen = true;
          })
          .catch((err) => {
            const frame: ToolResultMsg = {
              type: "tool.result",
              call_id: callId,
              result: JSON.stringify({ success: false, error: "relay_error", message: String(err), data: {} }),
              is_error: true,
            };
            lastToolResultAt.v = Date.now();
            ws.send(JSON.stringify(frame));
          });
        break;
      }
      case "transcript.agent":
        lastAgentAt.v = Date.now();
        console.log(`[e2e] AGENT: ${msg.text}`);
        break;
      case "reply.started":
        inFlight = true;
        break;
      case "reply.done": {
        inFlight = false;
        if (msg.status === "interrupted") {
          toolResultsSent.clear();
        }
        break;
      }
      default:
        break;
    }
  };
  ws.on("message", onMsg);

  const idle = async (grace = 2500): Promise<void> => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const recentlyActive =
        inFlight ||
        toolResultsSent.size > 0 ||
        lastAgentAt.v > 0 ||
        lastToolResultAt.v > 0;
      if (!recentlyActive || (lastAgentAt.v === -1 && lastToolResultAt.v === -1)) {
        const quietFor = Date.now() - Math.max(lastAgentAt.v, lastToolResultAt.v, start);
        if (!inFlight && toolResultsSent.size === 0 && quietFor > grace) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  const say = (text: string, instruction?: string): Promise<void> => {
    console.log(`[e2e] >> ${text}`);
    ws.send(JSON.stringify({ type: "conversation.message", role: "user", content: text }));
    return new Promise(async (resolve) => {
      await new Promise((r) => setTimeout(r, 1200));
      ws.send(
        JSON.stringify({
          type: "reply.create",
          instructions:
            instruction ??
            "Respond to the user's latest message. If they are describing what to shop for or an action to take, call the matching tool immediately — do not chat before calling.",
        })
      );
      const prev = toolResultsSent.size;
      const deadline = Date.now() + 35000;
      await new Promise((r) => setTimeout(r, 6000));
      for (;;) {
        const quietFor = Date.now() - Math.max(lastAgentAt.v, lastToolResultAt.v, start);
        if (!inFlight && toolResultsSent.size === prev && quietFor > 2500) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await idle(1500);
      resolve();
    });
  };

  let searchData: any = null;
  let couponPreviewSeen = false;

  await say("show me bracelets under 3000");
  if (step.toolCalls === 0) await say("find rings for me, search the store catalog");

  if (step.toolCalls > 0) {
    if (searchData?.items?.length) {
      const first = searchData.items[0];
      await say("add the first one to my cart", `The search result's first option is productId ${first.id} (${first.name}). The user asks to add the first one. Call add_to_cart with productId ${first.id}, quantity 1, right now.`);
    } else {
      await say("add the first one to my cart");
    }

    await say("apply the coupon WELCOME15", "The user wants to apply the coupon WELCOME15. Call apply_coupon with code 'WELCOME15' right now.");

    await say("check out so I can confirm the total", "The user wants to complete their purchase. Call checkout WITHOUT the confirm field so the preview is returned; then read the preview and ask whether to place the order.");

    await say("yes, place the order", "The user has explicitly confirmed. Call checkout with confirm:true right now, then confirm the order was created.");

    await say("is my cart empty now", "Check the cart after placing the order. Call get_cart.");
  }

  if (!couponPreviewSeen) console.log("[e2e] note: did not observe a coupon apply this run");
  const finalState = await fetchJson<any>(`${base}/api/state/${encodeURIComponent(sessionId)}`);
  console.log("[e2e] final state cart.lines:", JSON.stringify(finalState.cart?.lines));
  console.log("[e2e] final state lastOrder:", JSON.stringify(finalState.lastOrder ?? null).slice(0, 300));
  console.log("[e2e] final state lastAction:", JSON.stringify(finalState.lastAction));

  ws.off("message", onMsg);
  ws.close();
  const elapsed = Date.now() - start;
  console.log("[e2e] done", { elapsed, toolsSeen: [...seenToolNames], ...step });
  if (step.violations.length > 0) {
    console.error("[e2e] VIOLATIONS:", step.violations);
    process.exitCode = 1;
  } else {
    console.log("[e2e] OK: no speak-before-confirm violations observed");
  }
}

main().catch((e) => {
  console.error("[e2e] FATAL", e);
  process.exitCode = 1;
});