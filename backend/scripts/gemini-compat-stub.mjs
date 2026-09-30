/**
 * A stand-in for Google's OpenAI-compatibility endpoint.
 *
 * Run it to exercise the whole app on a Gemini-shaped provider without a live
 * Gemini key or quota:
 *
 *   node backend/scripts/gemini-compat-stub.mjs          # listens on :4601
 *   GEMINI_API_KEY=stub \
 *     GEMINI_BASE_URL=http://127.0.0.1:4601/v1beta/openai \
 *     npm run dev:backend
 *   npx tsx backend/scripts/e2e-gemini.ts
 *
 * It speaks the exact wire protocol the `openai` SDK produces against
 * https://generativelanguage.googleapis.com/v1beta/openai/ — so the real
 * GeminiClient, the real tool-calling loop and the real tools all run
 * unmodified. Only the MODEL is stubbed (deterministically, so the E2E run is
 * reproducible).
 *
 * It also acts as a guard: any request containing an image part is rejected and
 * recorded, so the E2E run proves the shopping conversation never sends a
 * picture to a model.
 *
 * Purpose: prove provider wiring end-to-end without a live Gemini key or quota.
 */
import http from "node:http";

const PORT = Number(process.env.STUB_PORT || 4601);
const log = [];

/** Any image part anywhere in the request. Should always be none. */
const imagesIn = (msgs) =>
  msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c && c.type === "image_url");
const textOf = (m) => {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  const t = (m.content || []).find((c) => c.type === "text");
  return t ? t.text : "";
};

let callSeq = 0;
/** Product ids seen in tool results, so follow-up tool calls can reference one. */
let knownIds = [];
const idFrom = (payload) => {
  const list = payload?.data?.items || payload?.data?.products || payload?.items || payload?.products || [];
  if (Array.isArray(list) && list.length) knownIds = list.map((p) => p.id).filter(Boolean);
  return knownIds[0] || null;
};
const toolCall = (name, args) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `call_${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
});
const say = (text) => ({ choices: [{ message: { role: "assistant", content: text } }] });

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {}
      const msgs = body.messages || [];
      const last = msgs[msgs.length - 1];
      const userText = textOf(msgs.find((m) => m.role === "user") || {});
      const images = imagesIn(msgs);
      const lower = userText.toLowerCase();
      log.push({ path: req.url, model: body.model, imageParts: images.length, lastRole: last?.role });

      // The catalog's appearance is text, so a conversation must never carry
      // an image. Fail loudly rather than answering, if one shows up.
      if (images.length) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "E2E GUARD: an image part was sent to the model" } }));
        return;
      }

      let out;

      if (last && last.role === "tool") {
        // A tool result came back: summarize it honestly from the tool payload.
        let payload = {};
        try {
          payload = JSON.parse(last.content);
        } catch {}
        idFrom(payload);
        out = say(
          payload.message ||
            payload.error ||
            "I couldn't complete that. You can still ask me about price, rating, or specifications."
        );
      } else if (/hello|hi\b|hey|echo\b/.test(lower)) {
        out = say("Hello! I'm Echo. Tell me what you're shopping for and I'll help.");
      } else if (
        /show|find|search|under|shirt|trouser|dress|shoe/.test(lower) &&
        !/cart|add|rating|look|colour|color|sleeve|casual/.test(lower)
      ) {
        out = toolCall("searchProducts", { q: /dress/.test(lower) ? "dress" : "shirt" });
      } else if (/add|first one|buy/.test(lower)) {
        out = toolCall("addToCart", { productId: knownIds[0] });
      } else if (/cart|basket/.test(lower)) {
        out = toolCall("getCart", {});
      } else if (/rating|price|spec/.test(lower)) {
        out = toolCall("getProduct", { productId: knownIds[0] });
      } else if (/look|colou?r|sleeve|casual|fit|pattern|neckline|appearance/.test(lower)) {
        // An appearance question is answered by opening the product, whose
        // stored appearance is the only permitted source.
        out = toolCall("getProduct", { productId: knownIds[0] });
      } else {
        out = say("Could you tell me a bit more about what you're looking for?");
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`[gemini-stub] listening on http://127.0.0.1:${PORT}`));

process.on("SIGTERM", () => {
  console.log("[gemini-stub] calls:", JSON.stringify(log.slice(-40)));
  process.exit(0);
});
