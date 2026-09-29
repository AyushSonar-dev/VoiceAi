import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readJson, newSession, getCapabilities, getState, getVoiceSetup, callTool, postTurn } from "../src/lib/api.js";
import type { Capabilities, EchoState, ToolResult, TurnEvents, VoiceAgentSetup, SseEvent } from "../src/types.js";

// Mock global fetch
const mockFetch = mock.fn();
global.fetch = mockFetch;

describe("api.ts", () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
  });

  describe("readJson", () => {
    test("throws on network error", async () => {
      mockFetch.mock.mockImplementationOnce(() => {
        throw new Error("Network error");
      });

      await assert.rejects(
        readJson("/api/test"),
        /could not reach its own server/
      );
    });

    test("throws on HTTP error with 5xx", async () => {
      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 500,
        })
      );

      await assert.rejects(
        readJson("/api/test"),
        /backend did not answer/
      );
    });

    test("throws on HTTP error with 4xx", async () => {
      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 404,
        })
      );

      await assert.rejects(
        readJson("/api/test"),
        /request to.*failed with 404/
      );
    });

    test("returns JSON on success", async () => {
      const testData = { success: true, data: "test" };
      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(testData),
        })
      );

      const result = await readJson<typeof testData>("/api/test");
      assert.deepEqual(result, testData);
    });
  });

  describe("newSession", () => {
    test("calls /api/session with POST and returns sessionId", async () => {
      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: "test-session-123" }),
        })
      );

      const sessionId = await newSession();
      assert.equal(sessionId, "test-session-123");
      assert.equal(mockFetch.mock.callCount(), 1);
      const call = mockFetch.mock.calls[0];
      assert.equal(call.arguments[0], "/api/session");
      assert.equal(call.arguments[1]?.method, "POST");
    });
  });

  describe("getCapabilities", () => {
    test("calls /api/capabilities", async () => {
      const capabilities: Capabilities = {
        db: "memory",
        stt: false,
        tts: false,
        llm: true,
        llmMode: "placeholder",
        voiceAgent: false,
        llmProvider: "none",
        currency: "₹",
        categories: ["Electronics", "Jewelry"],
      };

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(capabilities),
        })
      );

      const result = await getCapabilities();
      assert.deepEqual(result, capabilities);
    });
  });

  describe("getState", () => {
    test("calls /api/state without sessionId (from cookie)", async () => {
      const state: EchoState = {
        sessionId: "test-session",
        cart: { isEmpty: true, itemCount: 0, lines: [], linesText: "", subtotal: 0, couponCode: null, discountPercent: 0, discount: 0, total: 0 },
        recentProducts: [],
        lastAction: null,
        lastOrder: null,
      };

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(state),
        })
      );

      const result = await getState();
      assert.deepEqual(result, state);
      const call = mockFetch.mock.calls[0];
      assert.equal(call.arguments[0], "/api/state");
    });
  });

  describe("getVoiceSetup", () => {
    test("calls /api/voice/setup with POST", async () => {
      const setup: VoiceAgentSetup = {
        token: "test-token",
        session: { system_prompt: "test", greeting: "hello", tools: [], input: {}, output: {} },
      };

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(setup),
        })
      );

      const result = await getVoiceSetup();
      assert.deepEqual(result, setup);
      const call = mockFetch.mock.calls[0];
      assert.equal(call.arguments[0], "/api/voice/setup");
      assert.equal(call.arguments[1]?.method, "POST");
    });
  });

  describe("callTool", () => {
    test("calls /api/tools/:name with args and credentials", async () => {
      const result: ToolResult = { success: true, message: "OK", data: {} };

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(result),
        })
      );

      const res = await callTool("searchProducts", { category: "Jewelry" });
      assert.deepEqual(res, result);
      const call = mockFetch.mock.calls[0];
      assert.ok(call.arguments[0].includes("/api/tools/searchProducts"));
      assert.equal(call.arguments[1]?.method, "POST");
      assert.ok(call.arguments[1]?.credentials === "include");
    });
  });

  describe("postTurn", () => {
    test("handles SSE stream with multiple events", async () => {
      const events: SseEvent[] = [
        { type: "turn", payload: { userText: "hello" } },
        { type: "filler", payload: { text: "let me check", audioUrl: null } },
        { type: "final", payload: { reply: "I found it", audioUrl: "data:audio/...", state: null as any } },
      ];

      // Create SSE stream
      const encoder = new TextEncoder();
      const streamData = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(streamData));
          controller.close();
        },
      });

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          body: readable,
        })
      );

      const result = await postTurn({ text: "hello" });
      assert.equal(result.userText, "hello");
      assert.equal(result.filler?.text, "let me check");
      assert.equal(result.reply, "I found it");
      assert.equal(result.audioUrl, "data:audio/...");
    });

    test("throws on error event", async () => {
      const events: SseEvent[] = [
        { type: "turn", payload: { userText: "hello" } },
        { type: "error", payload: { message: "Something went wrong" } },
      ];

      const encoder = new TextEncoder();
      const streamData = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(streamData));
          controller.close();
        },
      });

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          body: readable,
        })
      );

      await assert.rejects(
        postTurn({ text: "hello" }),
        /Something went wrong/
      );
    });

    test("handles partial chunks across multiple reads", async () => {
      const events: SseEvent[] = [
        { type: "turn", payload: { userText: "hello" } },
        { type: "final", payload: { reply: "world", audioUrl: null, state: null as any } },
      ];

      const encoder = new TextEncoder();
      // Split the SSE data into multiple chunks to test buffering
      const fullData = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      const chunk1 = fullData.slice(0, fullData.length / 2);
      const chunk2 = fullData.slice(fullData.length / 2);

      let chunkIndex = 0;
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk1));
          controller.enqueue(encoder.encode(chunk2));
          controller.close();
        },
      });

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          body: readable,
        })
      );

      const result = await postTurn({ text: "hello" });
      assert.equal(result.userText, "hello");
      assert.equal(result.reply, "world");
    });

    test("ignores malformed frames", async () => {
      const encoder = new TextEncoder();
      // Mix valid and invalid SSE frames
      const fullData = `data: ${JSON.stringify({ type: "turn", payload: { userText: "hello" } })}\n\nINVALID FRAME\n\ndata: ${JSON.stringify({ type: "final", payload: { reply: "world", audioUrl: null, state: null } })}\n\n`;
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(fullData));
          controller.close();
        },
      });

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          body: readable,
        })
      );

      const result = await postTurn({ text: "hello" });
      assert.equal(result.userText, "hello");
      assert.equal(result.reply, "world");
    });

    test("throws when no reply received", async () => {
      const events: SseEvent[] = [
        { type: "turn", payload: { userText: "hello" } },
        // No final event
      ];

      const encoder = new TextEncoder();
      const streamData = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(streamData));
          controller.close();
        },
      });

      mockFetch.mock.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          body: readable,
        })
      );

      await assert.rejects(
        postTurn({ text: "hello" }),
        /assistant returned no reply/
      );
    });
  });
});