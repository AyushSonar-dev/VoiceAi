import { config } from "../config.js";
import { MemoryStore } from "./memoryStore.js";
import { MongoStore } from "./mongoStore.js";
import type { Store } from "../types.js";

let current: Store | null = null;
let mode: "memory" | "mongodb" | null = null;

export interface InitOptions {
  /** Tests/demo only: pin the clearly-marked in-memory placeholder store. */
  forceMemory?: boolean;
}

/**
 * Initialize the active data store.
 * - MONGODB_URI set  -> real MongoDB (MongoStore)
 * - MONGODB_URI unset -> clearly-marked in-memory PLACEHOLDER store
 */
export async function initStore(opts: InitOptions = {}): Promise<Store> {
  if (current) return current;

  if (opts.forceMemory || !config.mongoUri) {
    current = new MemoryStore();
    await current.init();
    mode = "memory";
  } else {
    current = new MongoStore();
    await current.init();
    mode = "mongodb";
  }
  return current;
}

export function getStore(): Store {
  if (!current) throw new Error("Store not initialized — call initStore() first.");
  return current;
}

export function getMode(): "memory" | "mongodb" | null {
  return mode;
}

// Internal test hook: replace the singleton with a fresh store on the next init.
export function __resetStoreForTests(): void {
  current = null;
  mode = null;
}

export function storeCapabilities() {
  return {
    db: mode,
    stt: Boolean(config.assemblyaiKey),
    tts: Boolean(config.elevenLabsKey),
    llm: Boolean(config.openaiKey),
    llmMode: config.openaiKey ? "openai-compatible" : "placeholder",
  };
}