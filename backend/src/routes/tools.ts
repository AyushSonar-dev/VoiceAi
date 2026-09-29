import { Router, type Request, type Response } from "express";
import { dispatchTool, VOICE_AGENT_TOOL_NAME_MAP } from "../tools/index.js";
import { requireAuth, requireSessionOwnership } from "../middleware/auth.js";

/**
 * The LLM's tool gateway over HTTP. This is the ONLY door to state changes.
 * Every request is validated inside the tool handler (product exists, stock,
 * valid coupon, referencable id, valid session) before any data is touched.
 * Requires authentication - the sessionId is derived from the auth token.
 */
export function toolsRouter(): Router {
  const router = Router();

  // All tool endpoints require authentication and session ownership
  router.post("/tools/:name", requireAuth, requireSessionOwnership, async (req: Request, res: Response) => {
    let name = req.params.name;
    // Voice Agent tool names are snake_case (per AssemblyAI guidance); map to
    // the backend's canonical tool names.
    name = VOICE_AGENT_TOOL_NAME_MAP[name] ?? name;

    // Inject the authenticated sessionId - do not trust client-provided sessionId
    const auth = (req as any).auth;
    const body = { ...req.body, sessionId: auth.sessionId };

    const result = await dispatchTool(name, body);
    res.json(result);
  });

  return router;
}