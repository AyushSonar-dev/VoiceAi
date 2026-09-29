import { Request, Response, NextFunction } from "express";
import { getStore } from "../db/index.js";
import { config } from "../config.js";
import crypto from "node:crypto";

/** Session token payload stored server-side. */
export interface SessionToken {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

/** In-memory session token store (replace with Redis in production). */
const tokenStore = new Map<string, SessionToken>();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Generate a cryptographically secure session token. */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Store a session token with its associated session ID. */
export function storeSessionToken(token: string, sessionId: string): void {
  const now = Date.now();
  tokenStore.set(token, {
    sessionId,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  });
}

/** Retrieve and validate a session token. */
export function getSessionToken(token: string): SessionToken | null {
  const data = tokenStore.get(token);
  if (!data) return null;
  if (Date.now() > data.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return data;
}

/** Delete a session token (logout). */
export function deleteSessionToken(token: string): void {
  tokenStore.delete(token);
}

/** Extract session token from request (cookie or Authorization header). */
export function extractSessionToken(req: Request): string | null {
  // First check cookie
  const cookieName = config.sessionCookieName;
  if (req.cookies?.[cookieName]) {
    return req.cookies[cookieName];
  }
  // Fallback: Authorization header (Bearer token)
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

/** Express middleware: attach authenticated session to request. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractSessionToken(req);
  if (!token) {
    res.status(401).json({ error: true, code: "unauthorized", message: "Authentication required" });
    return;
  }
  const sessionToken = getSessionToken(token);
  if (!sessionToken) {
    res.status(401).json({ error: true, code: "invalid_token", message: "Invalid or expired session" });
    return;
  }
  // Attach session info to request for downstream handlers
  (req as any).auth = { sessionId: sessionToken.sessionId, token };
  next();
}

/** Optional auth - attaches session if valid token present, but doesn't require it. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractSessionToken(req);
  if (token) {
    const sessionToken = getSessionToken(token);
    if (sessionToken) {
      (req as any).auth = { sessionId: sessionToken.sessionId, token };
    }
  }
  next();
}

/** Verify that the authenticated session owns the requested resource. */
export function requireSessionOwnership(req: Request, res: Response, next: NextFunction): void {
  const auth = (req as any).auth;
  if (!auth) {
    res.status(401).json({ error: true, code: "unauthorized", message: "Authentication required" });
    return;
  }
  const requestedSessionId = req.params.sessionId || req.body?.sessionId || req.query?.sessionId;
  if (requestedSessionId && requestedSessionId !== auth.sessionId) {
    res.status(403).json({ error: true, code: "forbidden", message: "Cannot access another session's data" });
    return;
  }
  next();
}

/** Clean up expired tokens periodically. */
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokenStore.entries()) {
    if (now > data.expiresAt) {
      tokenStore.delete(token);
    }
  }
}, 60 * 60 * 1000); // Every hour