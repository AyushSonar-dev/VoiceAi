import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { initStore } from "./db/index.js";
import { sessionRouter } from "./routes/session.js";
import { toolsRouter } from "./routes/tools.js";
import { stateRouter, capabilitiesRouter } from "./routes/state.js";
import { voiceRouter } from "./routes/voice.js";
import { optionalAuth } from "./middleware/auth.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { apiRateLimiter } from "./middleware/rateLimit.js";

export async function startServer(opts: { port?: number } = {}): Promise<Server> {
  await initStore();

  const app = express();

  // Request logging (first, so it captures everything)
  app.use(requestLogger);

  // Rate limiting for all API routes
  app.use("/api", apiRateLimiter);

  // CORS with credentials support
  const allowedOrigins = config.frontendOrigin.split(",").map((o) => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "30mb" }));
  app.use(cookieParser(config.sessionSecret));

  // Optional auth on all /api routes - attaches session if valid token present
  app.use("/api", optionalAuth);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api", sessionRouter());
  app.use("/api", toolsRouter());
  app.use("/api", stateRouter());
  app.use("/api", capabilitiesRouter());
  app.use("/api", voiceRouter());

  const port = opts.port ?? config.port;
  return app.listen(port, () => {
    console.log(`[ECHOLABS] backend listening on http://127.0.0.1:${port} (tool gateway + voice)`);
  });
}

// Main entry (dev/start). Tests and the demo script import startServer directly
// so they can bind an ephemeral port.
const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFile = path.resolve(fileURLToPath(import.meta.url));

if (entrypoint === currentFile) {
  startServer().catch((err) => {
    console.error("[ECHOLABS] failed to start:", err);
    process.exit(1);
  });
}