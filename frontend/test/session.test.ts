import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadSessionId, saveSessionId, clearSessionId } from "../src/lib/session.js";

// Mock window and localStorage for testing
const createMockWindow = () => {
  const storage = new Map<string, string>();
  return {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  };
};

const originalWindow = global.window;

describe("session.ts", () => {
  beforeEach(() => {
    global.window = createMockWindow() as any;
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  test("loadSessionId returns null when no session stored", () => {
    const result = loadSessionId();
    assert.equal(result, null);
  });

  test("saveSessionId and loadSessionId round-trip", () => {
    const testId = "test-session-123";
    saveSessionId(testId);
    const result = loadSessionId();
    assert.equal(result, testId);
  });

  test("clearSessionId removes stored session", () => {
    saveSessionId("test-session-123");
    clearSessionId();
    const result = loadSessionId();
    assert.equal(result, null);
  });

  test("functions handle missing window gracefully", () => {
    global.window = undefined as any;
    assert.equal(loadSessionId(), null);
    saveSessionId("test"); // Should not throw
    clearSessionId(); // Should not throw
    global.window = createMockWindow() as any;
  });
});