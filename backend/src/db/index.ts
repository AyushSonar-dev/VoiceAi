import { config } from "../config.js";
import { activeProviderName, geminiProfile } from "../agent/llm/providers.js";
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
 *
 * A configured-but-unreachable database must NOT take the whole app down: a
 * dead tool gateway means the website cannot connect to anything at all. So we
 * fall back to the in-memory store, say so loudly, and report `db: "memory"` via
 * /api/capabilities. Set REQUIRE_MONGO=true where persistence is mandatory (e.g.
 * production) to turn an unreachable database back into a hard boot failure.
 */
export async function initStore(opts: InitOptions = {}): Promise<Store> {
  if (current) return current;

  if (opts.forceMemory || !config.mongoUri) {
    current = new MemoryStore();
    await current.init();
    mode = "memory";
    return current;
  }

  try {
    const store = new MongoStore();
    await store.init();
    current = store;
    mode = "mongodb";
  } catch (err) {
    if (config.requireMongo) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      [
        "",
        "[ECHOLABS] MongoDB is UNREACHABLE — falling back to the in-memory store.",
        `          ${reason.split("\n")[0]}`,
        "          The app works, but nothing is persisted until this is fixed:",
        "          check MONGODB_URI in backend/.env (and that the IP allowlist includes this machine).",
        "          Set REQUIRE_MONGO=true to make this a fatal error instead.",
        "",
      ].join("\n")
    );
    current = new MemoryStore();
    await current.init();
    mode = "memory";
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
    llm: geminiProfile() !== null,
    llmMode: activeProviderName(),
  };
}