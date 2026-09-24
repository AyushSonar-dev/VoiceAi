import { Router } from "express";
import { getStore, getMode, storeCapabilities } from "../db/index.js";
import {
  requireSession,
  buildCartSummary,
} from "../tools/shared.js";
import { config } from "../config.js";

export interface EchoState {
  sessionId: string;
  cart: Awaited<ReturnType<typeof buildCartSummary>>;
  recentProducts: Array<{
    id: string;
    name: string;
    category: string;
    price: number;
    stock: number;
    rating: number;
    reviewCount: number;
    keySpecs: string[];
    inStock: boolean;
  }>;
  lastAction: unknown;
  lastOrder: unknown;
}

export async function buildState(sessionId: string): Promise<EchoState> {
  const store = getStore();
  const session = await requireSession(sessionId);
  const cart = await store.getOrCreateCart(sessionId);
  const summary = await buildCartSummary(cart);

  const products = await store.getProductsByIds(session.recentProductIds);
  const byId = new Map(products.map((p) => [p.id, p]));
  const recentProducts = session.recentProductIds
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({ ...p, inStock: p.stock > 0 }));

  const lastOrder = await store.getLatestOrder(sessionId);

  return {
    sessionId,
    cart: summary,
    recentProducts,
    lastAction: session.lastAction,
    lastOrder,
  };
}

export function stateRouter(): Router {
  const router = Router();

  // UI state snapshot used by the frontend to render products, cart, coupon and
  // last order in sync with the backend (the frontend never computes totals).
  router.get("/state/:sessionId", async (req, res) => {
    try {
      const state = await buildState(req.params.sessionId);
      res.json(state);
    } catch (err) {
      res.status(400).json({ error: true, message: (err as Error).message });
    }
  });

  return router;
}

export function capabilitiesRouter(): Router {
  const router = Router();
  router.get("/capabilities", async (_req, res) => {
    const cap = storeCapabilities();
    res.json({
      ...cap,
      db: getMode(),
      // Real voice = the AssemblyAI Voice Agent API (STT+LLM+TTS+turn-taking
      // in one WebSocket). When the key is absent, demo mode uses text-in only.
      voiceAgent: Boolean(config.assemblyaiKey),
      llmMode: config.assemblyaiKey ? "assemblyai-voice-agent" : cap.llmMode,
      currency: config.currency,
      categories: Array.from(new Set(["Electronics", "Jewelry", "Men's Clothing", "Women's Clothing"])),
    });
  });
  return router;
}