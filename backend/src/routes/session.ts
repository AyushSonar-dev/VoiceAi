import { Router, type Response } from "express";
import crypto from "node:crypto";
import { getStore } from "../db/index.js";
import { config } from "../config.js";
import { generateSessionToken, storeSessionToken, deleteSessionToken } from "../middleware/auth.js";
import { strictRateLimiter } from "../middleware/rateLimit.js";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: false, // Set to true in production with HTTPS
  sameSite: "lax" as const,
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  path: "/",
};

export function sessionRouter(): Router {
  const router = Router();

  // Create a fresh session and issue a secure session token.
  // Strict rate limiting on session creation
  router.post("/session", strictRateLimiter, async (_req, res: Response) => {
    const store = getStore();
    const sessionId = crypto.randomUUID();
    await store.getOrCreateSession(sessionId);

    const token = generateSessionToken();
    storeSessionToken(token, sessionId);

    // Set HTTP-only cookie
    res.cookie(config.sessionCookieName, token, COOKIE_OPTIONS);

    // Also return sessionId in body for backward compatibility with demo/tests
    res.json({ sessionId, token });
  });

  // End session (logout)
  router.post("/session/end", async (req, res) => {
    const token = req.cookies?.[config.sessionCookieName];
    if (token) {
      deleteSessionToken(token);
      res.clearCookie(config.sessionCookieName, { ...COOKIE_OPTIONS, maxAge: 0 });
    }
    res.json({ success: true });
  });

  return router;
}