import { Router } from "express";
import { dispatchTool } from "../tools/index.js";

/**
 * The LLM's tool gateway over HTTP. This is the ONLY door to state changes.
 * Every request is validated inside the tool handler (product exists, stock,
 * valid coupon, referencable id, valid session) before any data is touched.
 */
export function toolsRouter(): Router {
  const router = Router();

  router.post("/tools/:name", async (req, res) => {
    const name = req.params.name;
    const result = await dispatchTool(name, req.body ?? {});
    res.json(result);
  });

  return router;
}