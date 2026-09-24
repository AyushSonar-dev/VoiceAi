import express from "express";
import cors from "cors";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { initStore } from "./db/index.js";
import { sessionRouter } from "./routes/session.js";
import { toolsRouter } from "./routes/tools.js";
import { stateRouter, capabilitiesRouter } from "./routes/state.js";
import { voiceRouter } from "./routes/voice.js";

export async function startServer(opts: { port?: number } = {}): Promise<Server> {
  await initStore();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "30mb" }));

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