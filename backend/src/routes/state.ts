import { Router, type Request, type Response } from "express";
import { getStore, getMode, storeCapabilities } from "../db/index.js";
import {
  requireSession,
  buildCartSummary,
} from "../tools/shared.js";
import { config } from "../config.js";
import { activeProviderName } from "../agent/llm/providers.js";
import type { ProductAppearance } from "../types.js";
import { requireAuth } from "../middleware/auth.js";

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
    /** The catalog's own visual description. Absent means the catalog does not
     *  describe this item's look — the UI says so rather than inventing one. */
    appearance?: ProductAppearance;
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
    .map((p) => {
      // `appearance` is catalog data, not something derived per session, so it
      // can be rendered directly and is identical for every shopper.
      return {
        ...p,
        inStock: p.stock > 0,
        ...(p.appearance ? { appearance: p.appearance } : {}),
      };
    });

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

  // UI state snapshot - requires authentication, uses authenticated session
  router.get("/state", requireAuth, async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth;
      const state = await buildState(auth.sessionId);
      res.json(state);
    } catch (err) {
      res.status(400).json({ error: true, message: (err as Error).message });
    }
  });

  // Legacy endpoint for backward compatibility - requires auth and ownership
  router.get("/state/:sessionId", requireAuth, async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth;
      const requestedSessionId = req.params.sessionId;
      if (requestedSessionId !== auth.sessionId) {
        res.status(403).json({ error: true, code: "forbidden", message: "Cannot access another session's state" });
        return;
      }
      const state = await buildState(requestedSessionId);
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
      // Which LLM vendor is actually driving the brain. Reported separately so
      // it stays visible even when llmMode is describing the voice path.
      llmProvider: activeProviderName(),
      currency: config.currency,
      categories: Array.from(new Set(["Electronics", "Jewelry", "Men's Clothing", "Women's Clothing"])),
    });
  });
  return router;
}