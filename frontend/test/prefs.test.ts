import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readPrefs, write, DEFAULTS, clamp, detectZoomSupport, MAGNIFY_STEPS, TEXT_SIZE_MIN, TEXT_SIZE_MAX, readString, readNumber, readBool } from "../src/lib/prefs.js";

// Mock localStorage for testing
const createMockStorage = () => {
  const storage = new Map<string, string>();
  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    _storage: storage,
  };
};

// Replace global localStorage for testing
const originalLocalStorage = global.localStorage;

// Mock CSS.supports for testing
const originalCSS = global.CSS;
global.CSS = {
  supports: (property: string, value: string) => {
    if (property === "zoom" && value === "1.5") return true;
    return false;
  },
} as any;

describe("prefs.ts - pure functions", () => {
  let mockStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    mockStorage = createMockStorage();
    global.localStorage = mockStorage as any;
  });

  afterEach(() => {
    global.localStorage = originalLocalStorage;
  });

  describe("readString", () => {
    test("returns value when key exists", () => {
      mockStorage._storage.set("test-key", "test-value");
      assert.equal(readString("test-key"), "test-value");
    });

    test("returns null when key missing", () => {
      assert.equal(readString("missing-key"), null);
    });
  });

  describe("readNumber", () => {
    test("returns parsed number", () => {
      mockStorage._storage.set("num-key", "42");
      assert.equal(readNumber("num-key"), 42);
    });

    test("returns null for non-numeric", () => {
      mockStorage._storage.set("num-key", "not-a-number");
      assert.equal(readNumber("num-key"), null);
    });

    test("returns null for missing key", () => {
      assert.equal(readNumber("missing"), null);
    });
  });

  describe("readBool", () => {
    test("returns true for 'true'", () => {
      mockStorage._storage.set("bool-key", "true");
      assert.equal(readBool("bool-key"), true);
    });

    test("returns false for 'false'", () => {
      mockStorage._storage.set("bool-key", "false");
      assert.equal(readBool("bool-key"), false);
    });

    test("returns null for other values", () => {
      mockStorage._storage.set("bool-key", "yes");
      assert.equal(readBool("bool-key"), null);
    });
  });

  describe("clamp", () => {
    test("clamps values within range", () => {
      assert.equal(clamp(50, 0, 100), 50);
      assert.equal(clamp(-10, 0, 100), 0);
      assert.equal(clamp(150, 0, 100), 100);
    });
  });

  describe("detectZoomSupport", () => {
    test("returns true when CSS.supports zoom", () => {
      assert.equal(detectZoomSupport(), true);
    });

    test("returns false when CSS.supports not available", () => {
      const originalCSS = global.CSS;
      // @ts-ignore
      global.CSS = undefined;
      assert.equal(detectZoomSupport(), false);
      global.CSS = originalCSS;
    });
  });

  describe("MAGNIFY_STEPS", () => {
    test("contains expected values", () => {
      assert.deepEqual(MAGNIFY_STEPS, [100, 125, 150, 200]);
    });
  });

  describe("TEXT_SIZE bounds", () => {
    test("has correct min and max", () => {
      assert.equal(TEXT_SIZE_MIN, 85);
      assert.equal(TEXT_SIZE_MAX, 160);
    });
  });
});

// For readPrefs which uses localStorage directly, we need a different approach
// Since it's harder to test in Node, we'll just test the DEFAULTS constant
describe("prefs.ts - constants", () => {
  test("DEFAULTS has expected values", () => {
    const defaults = {
      theme: "dark",
      textSizePercent: 100,
      magnify: 100,
      reducedMotion: null,
    };
    assert.deepEqual(DEFAULTS, defaults);
  });

  test("MAGNIFY_STEPS contains expected values", () => {
    assert.deepEqual(MAGNIFY_STEPS, [100, 125, 150, 200]);
  });

  test("TEXT_SIZE bounds are correct", () => {
    assert.equal(TEXT_SIZE_MIN, 85);
    assert.equal(TEXT_SIZE_MAX, 160);
  });
});