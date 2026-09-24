import type { Llm, ChatRequest, ChatResponse, ToolCallRequest } from "./types.js";
import type { ToolResult } from "../../types.js";
import { ALLOWED_CATEGORIES, config, formatPrice } from "../../config.js";

/**
 * PLACEHOLDER BRAIN (clearly marked).
 *
 * Runs ONLY while OPENAI_API_KEY is unset, so the tool-use loop (and the whole
 * voice pipeline) stays testable and demoable end-to-end before a real LLM key
 * is provided. It implements the exact same Llm interface as OpenAiClient and
 * exercises the SAME loop code — it calls tools, waits for their results, and
 * only then speaks (never fabricates outcomes, because its replies quote the
 * backend's tool.message).
 *
 * Swap to the real brain the moment OPENAI_API_KEY is set: llm/index.ts does it.
 */
export class PlaceholderBrain implements Llm {
  /** Debug trail exposed for tests/observability. */
  readonly history: Array<{ phase: string; note: string }> = [];

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages;
    const last = messages[messages.length - 1];

    if (last.role === "tool") {
      // A tool result is back. Only now may we speak about it. But if the user
      // also asked to add/remove "the first/second" item right after a search,
      // resolve that referent against the search result and keep the chain
      // going (still a real tool-use loop — the brain just doesn't create ids).
      const followUp = await this.maybeFollowUpReferent(messages);
      if (followUp) return { message: { role: "assistant", content: "", tool_calls: followUp } };
      return this.replyFromToolResult(messages);
    }

    if (last.role === "user" || (last.role === "assistant" && !last.tool_calls)) {
      return this.planFromUserMessage(messages);
    }

    // Defensive: mid-loop assistant message with unfinished tool calls.
    return { message: { role: "assistant", content: "Give me one moment." } };
  }

  // ------------------------------------------------------------------ planning

  private planFromUserMessage(messages: ChatRequest["messages"]): ChatResponse {
    const system = messages.find((m) => m.role === "system");
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    const text = (userMsg?.content ?? "").trim();
    const low = text.toLowerCase();

    const ctx = this.contextFromSystem(system?.content ?? "");

    if (!text) {
      return { message: { role: "assistant", content: "Sorry, I didn't catch that. Could you say it again?" } };
    }

    // --- confirm a checkout that's in preview ---
    if (ctx.lastAction?.type === "checkout_preview" && this.isYes(low)) {
      return this.emit("checkout", { sessionId: ctx.sessionId, confirm: true });
    }

    // --- explicit checkout request (preview first!) ---
    if (/(check\s*out|checkout|place (my )?order|place the order|buy (these|all|my items|it)?)/.test(low)) {
      return this.emit("checkout", { sessionId: ctx.sessionId });
    }

    // --- search / browse ---
    if (
      /(show|find|search|look(ing)? for|get me|need|want|browse|suggest|recommend|looking)/.test(low) ||
      /(^|\s)(elect|jewel|clothing|shirt|dress|earbud|watch|speaker|lamp|jacket|sweater|necklace|bracelet|bag|shoe)/.test(low) ||
      /under\s+(?:rupees|rs\.?|inr|\u20b9)?\s*\d/.test(low) ||
      /\d[\d,]*\s*(?:rupees|rs\.?|inr)/.test(low)
    ) {
      const params = this.buildSearchParams(low, ctx.sessionId);
      return this.emit("searchProducts", params);
    }

    // --- cart contents ---
    if (/(what.*cart|cart.*to?tal|my (shopping )?cart|anything in my cart|cart contents)/.test(low)) {
      return this.emit("getCart", { sessionId: ctx.sessionId });
    }

    // --- coupon ---
    if (/(coupon|promo|code|discount|voucher|offer)/.test(low)) {
      const code = low.match(/\b([a-z]{3,}\d{0,2})\b/i)?.[1];
      if (code && code !== "coupon" && code !== "promo") {
        return this.emit("applyCoupon", { sessionId: ctx.sessionId, code: code.toUpperCase() });
      }
      // No code given -> just report the cart state / ask for a code.
      return { message: { role: "assistant", content: "Which coupon code would you like to use? For example, WELCOME15." } };
    }

    // --- add to cart ---
    const addMatch = /(add|put|include|stick|throw).*?(cart|basket|order)|add .* (to|in)/.test(low);
    if (addMatch) {
      return this.resolveCartAction(text, ctx, "addToCart");
    }

    // --- remove from cart ---
    if (/(remove|take (it )?out|delete|drop|get rid of|minus)/.test(low)) {
      return this.resolveCartAction(text, ctx, "removeFromCart");
    }

    // --- product detail ---
    if (/(tell me (more|about)|more about|about the|details|specs|specifications|info on|show me that)/.test(low)) {
      const id = this.resolveReferent(text, ctx.recentProductIds);
      if (id) return this.emit("getProduct", { sessionId: ctx.sessionId, productId: id });
      return this.productReferentQuestion();
    }

    // --- unclear: ask, never guess on a state-changing action ---
    return {
      message: {
        role: "assistant",
        content:
          "I want to make sure I get that right. Are you looking for something specific — say what you'd like, a category, or a budget — or would you like to hear what's in your cart?",
      },
    };
  }

  private buildSearchParams(low: string, sessionId: string): Record<string, unknown> {
    const params: Record<string, unknown> = { sessionId, maxResults: 2 };
    const category = ALLOWED_CATEGORIES.find((c) => low.includes(c.toLowerCase()));
    if (category) params.category = category;
    const price = low.match(/(?:under|below|within|less than|no more than|max|budget(?: of)?)\s*(?:rupees|rs\.?|inr|\u20b9)\s*([\d,]+)/i) ??
      low.match(/(?:under|below|within|less than)\s*([\d,]+)\s*(?:rupees|rs\.?|inr|\u20b9)?/i) ??
      low.match(/(?:rupees|rs\.?|inr|\u20b9)\s*([\d,]+)/i);
    if (price && price[1]) params.maxPrice = Number(price[1].replace(/,/g, ""));
    const rating = low.match(/(\d(?:\.\d)?)\s*(?:\+)?\s*star/i);
    if (rating && rating[1]) params.minRating = Number(rating[1]);

    // Purpose/keywords derived from the utterance minus stopwords.
    const stopWords =
      /^(show|find|search|looking|look|for|me|please|i|want|need|get|some|the|a|an|under|below|with|in|my|cart|browse|suggest|recommend|around|about|up|to|rupees|\u20b9|rs\.?|inr)$/i;
    const categoryWords = new Set(ALLOWED_CATEGORIES.map((c) => c.toLowerCase()));
    const terms = low
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]+/gi, ""))
      .filter((w) => w && !stopWords.test(w) && !categoryWords.has(w.toLowerCase()) && !/^\d/.test(w));
    if (terms.length) params.q = terms.join(" ");
    return params;
  }

  private resolveCartAction(text: string, ctx: SessionContext, tool: "addToCart" | "removeFromCart"): ChatResponse {
    const id = this.resolveReferent(text, ctx.recentProductIds);
    if (!id) {
      if (!ctx.recentProductIds.length) {
        return {
          message: {
            role: "assistant",
            content:
              "I haven't shown you any products yet, so I'd rather not guess. Tell me what you'd like and I'll search first.",
          },
        };
      }
      return this.productReferentQuestion();
    }
    const qtyMatch = text.match(/\badd\s+(\d+)\b/i) ?? text.match(/\b(\d+)\s+of (them|those|it)\b/i);
    const params: Record<string, unknown> = { sessionId: ctx.sessionId, productId: id };
    if (tool === "addToCart" && qtyMatch?.[1]) params.quantity = Number(qtyMatch[1]);
    return this.emit(tool, params);
  }

  private resolveReferent(text: string, ids: string[]): string | null {
    if (!ids.length) return null;
    // Direct id mention.
    for (const id of ids) if (text.includes(id)) return id;
    // Positional referents ("the first one", "second", "option 2").
    const map: Record<string, number> = {
      first: 0, "1st": 0, one: 0, second: 1, "2nd": 1, two: 1,
      third: 2, "3rd": 2, three: 2, fourth: 3, "4th": 3, four: 3,
    };
    const words = text.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-z0-9]+/g, "");
      if (w === "option" && i + 1 < words.length && map[words[i + 1]] !== undefined) {
        const idx = map[words[i + 1].replace(/[^a-z0-9]+/g, "")];
        return ids[idx] ?? null;
      }
      if (map[w] !== undefined) {
        const surrounded = words[i - 1] === "the" || words[i + 1] === "one" || words[i + 1] === "option";
        if (w === "one" || w === "two" || w === "three" || w === "four") {
          if (surrounded) return ids[map[w]] ?? null;
        } else {
          return ids[map[w]] ?? null;
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ mid-chain

  private async maybeFollowUpReferent(messages: ChatRequest["messages"]): Promise<ToolCallRequest[] | null> {
    const lastTool = messages[messages.length - 1];
    let result: ToolResult;
    try {
      result = JSON.parse(lastTool.content) as ToolResult;
    } catch {
      return null;
    }

    if (lastTool.tool_call_id && result.success && result.message.toLowerCase().includes("found")) {
      const userMsg = [...messages].reverse().find((m) => m.role === "user");
      const text = (userMsg?.content ?? "").toLowerCase();
      const system = messages.find((m) => m.role === "system");
      const ctx = this.contextFromSystem(system?.content ?? "");

      // "add/remove/tell me about the (first|second)..." right after a fresh search
      const option = this.resolveReferent(text, ctx.recentProductIds);
      if (!option) return null;

      if (/(add|put|include|stick).*cart/.test(text)) {
        return [{ id: `call_fu_${Date.now()}`, function: { name: "addToCart", arguments: JSON.stringify({ sessionId: ctx.sessionId, productId: option }) } }];
      }
      if (/(remove|take out|delete|drop)/.test(text)) {
        return [{ id: `call_fu_${Date.now()}`, function: { name: "removeFromCart", arguments: JSON.stringify({ sessionId: ctx.sessionId, productId: option }) } }];
      }
      if (/(tell me (more|about)|more about|details|specs|about the)/.test(text)) {
        return [{ id: `call_fu_${Date.now()}`, function: { name: "getProduct", arguments: JSON.stringify({ sessionId: ctx.sessionId, productId: option }) } }];
      }
    }
    return null;
  }

  private replyFromToolResult(messages: ChatRequest["messages"]): ChatResponse {
    const lastTool = messages[messages.length - 1];
    try {
      const result = JSON.parse(lastTool.content) as ToolResult;
      // Search results carry an instruction line meant for a real model; the
      // placeholder shouldn't read long ids out loud to a user.
      const core = (result.message ?? "Okay.")
        .split("\n\nUse the exact \"Option N\"")[0]
        .trim();
      return {
        message: { role: "assistant", content: this.composeFinal(core, result) },
      };
    } catch {
      return { message: { role: "assistant", content: "Hmm, I hit a snag there. Could you rephrase that?" } };
    }
  }

  private composeFinal(core: string, result: ToolResult): string {
    const closings: string[] = [
      "",
      "",
      " What else can I do for you?",
      " Happy to keep going from here.",
      " Let me know if you'd like to add anything or check out.",
      " Just say the word and I'll keep helping.",
      " Anything else you had in mind?",
    ];
    const pick = closings[Math.floor(Math.random() * closings.length)];
    const base = core.trim().endsWith("?") ? core.trim() : `${core.trim()}${pick}`;
    return base;
  }

  // ------------------------------------------------------------------ helpers

  private emit(name: string, args: Record<string, unknown>): ChatResponse {
    this.history.push({ phase: "emit", note: `${name} ${JSON.stringify(args)}` });
    return {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: `call_${Date.now()}_${Math.round(Math.random() * 1e6)}`, function: { name, arguments: JSON.stringify(args) } }],
      },
    };
  }

  private isYes(low: string): boolean {
    return /^(yes|yeah|yep|sure|ok|okay|go ahead|please|confirm|place it|place the order|that'?s (fine|great|good)|sounds good)/.test(
      low.trim().replace(/[^a-z0-9'\s]/g, "")
    );
  }

  private productReferentQuestion(): ChatResponse {
    return {
      message: {
        role: "assistant",
        content:
          "Which one do you mean? I've shown you a few options — say 'the first one' or 'the second one', or tell me again what you're looking for.",
      },
    };
  }

  private contextFromSystem(system: string): SessionContext {
    const sessionId = system.match(/sessionId:\s*(\S+)/)?.[1] ?? "";
    const idsLine = system.match(/productIds available to reference this turn:\s*(.+)$/m)?.[1] ?? "";
    const recentProductIds = idsLine.startsWith("(none")
      ? []
      : idsLine
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    const laLine = system.match(/last recorded action:\s*(.+)$/m)?.[1] ?? "none";
    let lastAction: SessionContext["lastAction"] = null;
    if (!laLine.startsWith("none")) {
      try {
        lastAction = JSON.parse(laLine);
      } catch {
        lastAction = null;
      }
    }
    return { sessionId, recentProductIds, lastAction };
  }
}

interface SessionContext {
  sessionId: string;
  recentProductIds: string[];
  lastAction: { type: string; [k: string]: unknown } | null;
}

// re-export for docs/tests
export { config, formatPrice };