import { Router } from "express";
import { dispatchTool, VOICE_AGENT_TOOL_NAME_MAP } from "../tools/index.js";

/**
 * The LLM's tool gateway over HTTP. This is the ONLY door to state changes.
 * Every request is validated inside the tool handler (product exists, stock,
 * valid coupon, referencable id, valid session) before any data is touched.
 */
export function toolsRouter(): Router {
  const router = Router();

  router.post("/tools/:name", async (req, res) => {
    let name = req.params.name;
    // Voice Agent tool names are snake_case (per AssemblyAI guidance); map to
    // the backend's canonical tool names.
    name = VOICE_AGENT_TOOL_NAME_MAP[name] ?? name;
    const result = await dispatchTool(name, req.body ?? {});
    res.json(result);
  });

  return router;
}