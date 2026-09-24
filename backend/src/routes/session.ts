import { Router } from "express";
import crypto from "node:crypto";
import { getStore } from "../db/index.js";

export function sessionRouter(): Router {
  const router = Router();

  // Create a fresh, anonymous session (no auth — hackathon mock).
  router.post("/session", async (_req, res) => {
    const store = getStore();
    const sessionId = crypto.randomUUID();
    await store.getOrCreateSession(sessionId);
    res.json({ sessionId });
  });

  return router;
}