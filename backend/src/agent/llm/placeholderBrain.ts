import type { Llm, ChatRequest, ChatResponse, ToolCallRequest } from "./types.js";
import type { ToolResult } from "../../types.js";
import { ALLOWED_CATEGORIES, config, formatPrice } from "../../config.js";

/**
 * PLACEHOLDER BRAIN (clearly marked).
 *
 * Runs ONLY while GEMINI_API_KEY is unset, so the tool-use loop (and the whole
 * voice pipeline) stays testable and demoable end-to-end before a real LLM key
 * is provided. It implements the exact same Llm interface as GeminiClient and
 * exercises the SAME loop code — it calls tools, waits for their results, and
 * only then speaks (never fabricates outcomes, because its replies quote the
 * backend's tool.message).
 *
 * Swap to the real brain the moment GEMINI_API_KEY is set: llm/index.ts does it.
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

    const addIntent = /(add|put|include|stick|throw).*?(cart|basket|order)|add .* (to|in)/.test(low);
    const removeIntent = /(remove|take (it )?out|delete|drop|get rid of|minus)/.test(low);
    const detailIntent = /(tell me (more|about)|more about|about the|details|specs|specifications|info on|show me that)/.test(low);
    const cartIntent = /(what.*cart|cart.*to?tal|my (shopping )?cart|anything in my cart|cart contents)/.test(low);
    const searchIntent =
      /(show|find|search|look(ing)? for|get me|need|want|browse|suggest|recommend|looking)/.test(low) ||
      /(^|\s)(elect|jewel|clothing|shirt|dress|earbud|watch|speaker|lamp|jacket|sweater|necklace|bracelet|bag|shoe)/.test(low) ||
      /under\s+(?:rupees|rs\.?|inr|\u20b9)?\s*\d/.test(low) ||
      /\d[\d,]*\s*(?:rupees|rs\.?|inr)/.test(low);

    // --- "find X and add/remove/tell me about the first one" in one breath:
    //     run the search FIRST, then the follow-up referent resolves against it.
    if (addIntent && searchIntent) {
      return this.emit("searchProducts", this.buildSearchParams(low, ctx.sessionId));
    }

    // --- cart contents (never shadow an add/remove utterance) ---
    if (cartIntent && !addIntent && !removeIntent) {
      return this.emit("getCart", { sessionId: ctx.sessionId });
    }

    // --- add to cart ---
    if (addIntent) {
      return this.resolveCartAction(text, ctx, "addToCart");
    }

    // --- remove from cart (by handed id, or by the user's own words) ---
    if (removeIntent) {
      const id = this.resolveReferent(text, ctx.recentProductIds);
      if (id) return this.emit("removeFromCart", { sessionId: ctx.sessionId, productId: id });
      const name = this.nameFromMessage(text);
      if (name) return this.emit("removeFromCart", { sessionId: ctx.sessionId, productName: name });
      if (ctx.recentProductIds.length) return this.productReferentQuestion();
      return {
        message: {
          role: "assistant",
          content:
            "I want to make sure I remove the right thing. Tell me which cart item to take out, like “remove the pearl earrings from my cart”.",
        },
      };
    }

    // --- what does it LOOK like: fetch the stored description, never recall it ---
    if (this.isVisualIntent(low)) {
      const target = this.resolveVisualTarget(text, ctx);
      if (target) return this.emit("getProduct", target);
      if (ctx.recentProductIds.length) return this.productReferentQuestion();
    }

    // --- compare two or more named options ---
    if (/\b(compare|versus|\bvs\.?\b|difference between|better than)\b/.test(low)) {
      const ids = this.resolveMultipleReferents(text, ctx.recentProductIds);
      if (ids.length >= 2) {
        return this.emitMany(ids.map((productId) => ({ name: "getProduct", args: { sessionId: ctx.sessionId, productId } })));
      }
      if (ids.length === 1) return this.emit("getProduct", { sessionId: ctx.sessionId, productId: ids[0] });
      if (ctx.recentProductIds.length) return this.productReferentQuestion();
    }

    // --- product detail ---
    if (detailIntent) {
      const id = this.resolveReferent(text, ctx.recentProductIds);
      if (id) return this.emit("getProduct", { sessionId: ctx.sessionId, productId: id });
      return this.productReferentQuestion();
    }

    // --- search / browse ---
    if (searchIntent) {
      return this.emit("searchProducts", this.buildSearchParams(low, ctx.sessionId));
    }

    // --- coupon ---
    if (/(coupon|promo|code|discount|voucher|offer|welcome\d{0,2}|save\d{0,2}|vip\d{0,2}|flash\d{0,2})/.test(low)) {
      const code = low.match(/\b([a-z]{3,}\d{1,2})\b/i)?.[1];
      if (code && !/^(coupon|promo|code|discount|voucher|offer)$/i.test(code)) {
        return this.emit("applyCoupon", { sessionId: ctx.sessionId, code: code.toUpperCase() });
      }
      // No code given -> just report the cart state / ask for a code.
      return { message: { role: "assistant", content: "Which coupon code would you like to use? For example, WELCOME15." } };
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

  /**
   * Does this ask about APPEARANCE rather than facts? Deliberately narrow: it
   * keys on visual nouns (colour, pattern, sleeves, neckline, pockets, screen,
   * stones…) and on appearance verbs ("what does it look like"), so a plain
   * browse request like "show me some bracelets" stays a search.
   */
  private isVisualIntent(low: string): boolean {
    if (/(add|remove|delete|check\s*out|checkout|coupon|apply the code)/.test(low)) return false;
    const visualNoun =
      /(colou?r|pattern|look|looks|appear|appearance|sleeve|sleeves|neckline|neck line|v-neck|crew neck|polo collar|collared|pocket|pockets|strap|straps|length|midi|maxi|mini|floral|stripe|striped|plaid|plain|solid|shiny|matte|satin|silk|denim|fabric|material|shape|cut|fit|drape|hem|screen|display|ports?|charging|stone|stones|gem|gems|pendant|chain)/;
    const appearanceVerb = /(look like|looks like|how does .* look|what does .* look|describe|see it|seeing it|appearance)/;
    return visualNoun.test(low) || appearanceVerb.test(low);
  }

  /**
   * Which product the user means for an appearance question:
   *  - an explicit "the first one" / "the second one" wins,
   *  - otherwise the product the last action was about, when that action named
   *    a single product ("does it have pockets?") — so a follow-up resolves to
   *    the same item without the shopper having to say it again,
   *  - otherwise the most recently mentioned product in context,
   *  - otherwise null, and the caller asks instead of guessing.
   *
   * There is no per-session "described" memory to consult: the appearance now
   * lives on the product itself, so re-fetching the same productId is both
   * correct and free of any image work.
   */
  private resolveVisualTarget(
    text: string,
    ctx: SessionContext
  ): Record<string, unknown> | null {
    const explicit = this.resolveReferent(text, ctx.recentProductIds);
    if (explicit) return { sessionId: ctx.sessionId, productId: explicit };

    const current = this.lastActionProductId(ctx);
    if (current) return { sessionId: ctx.sessionId, productId: current };

    if (ctx.recentProductIds.length === 1) {
      return { sessionId: ctx.sessionId, productId: ctx.recentProductIds[0] };
    }
    // A search left several options in context and nothing narrowed it down:
    // only guess if the shopper named an ordinal, which resolveReferent did.
    return null;
  }

  /**
   * The single product the last action was about, when that action named one
   * and it is still referenceable. This is what makes "it", "this one" and a
   * bare follow-up resolve to the product currently under discussion without
   * inventing anything: the id came from a real tool result this session.
   */
  private lastActionProductId(ctx: SessionContext): string | null {
    const lastAction = ctx.lastAction as { type?: string; productId?: string } | null;
    if (!lastAction || (lastAction.type !== "getProduct" && lastAction.type !== "addToCart")) return null;
    const productId = lastAction.productId;
    if (!productId || !ctx.recentProductIds.includes(productId)) return null;
    return productId;
  }

  private buildSearchParams(low: string, sessionId: string): Record<string, unknown> {    const params: Record<string, unknown> = { sessionId, maxResults: 2 };
    const category = ALLOWED_CATEGORIES.find((c) => low.includes(c.toLowerCase()));
    if (category) params.category = category;
    const price = low.match(/(?:under|below|within|less than|no more than|max|budget(?: of)?)\s*(?:rupees|rs\.?|inr|\u20b9)\s*([\d,]+)/i) ??
      low.match(/(?:under|below|within|less than)\s*([\d,]+)\s*(?:rupees|rs\.?|inr|\u20b9)?/i) ??
      low.match(/(?:rupees|rs\.?|inr|\u20b9)\s*([\d,]+)/i);
    if (price && price[1]) params.maxPrice = Number(price[1].replace(/,/g, ""));
    const rating = low.match(/(\d(?:\.\d)?)\s*(?:\+)?\s*star/i);
    if (rating && rating[1]) params.minRating = Number(rating[1]);

    // Purpose/keywords derived from the utterance minus stopwords. The filler
    // words that carry no search meaning ("something", "in", "of") have to go,
    // or an AND-search over the leftovers finds nothing at all.
    const stopWords =
      /^(show|find|search|searching|looking|look|for|me|please|i|want|need|get|some|something|anything|thing|things|item|items|stuff|colour|colou?r|coloured|colou?red|of|any|the|a|an|under|below|within|with|and|or|in|on|at|my|cart|browse|suggest|recommend|around|about|up|to|rupees|\u20b9|rs\.?|inr)$/i;
    const categoryWords = new Set(ALLOWED_CATEGORIES.map((c) => c.toLowerCase()));
    const terms = low
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]+/gi, ""))
      .filter((w) => w && !stopWords.test(w) && !categoryWords.has(w.toLowerCase()) && !/^\d/.test(w));
    if (terms.length) params.q = terms.join(" ");
    return params;
  }

  private resolveCartAction(text: string, ctx: SessionContext, tool: "addToCart" | "removeFromCart"): ChatResponse {
    // "it" / "this one" after a product was just opened means that product.
    // The last action naming a single product is the only reliable way to know
    // which one, and it keeps a bare "add it" from ever being a guess.
    const id = this.resolveReferent(text, ctx.recentProductIds) ?? this.lastActionProductId(ctx);
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

  /** Best-effort product-name from the user's own words (used only for
   *  remove-by-name, where the user is naming what they already put in the
   *  cart — no hallucinated ids involved). */
  private nameFromMessage(text: string): string | null {
    const ignored =
      /^(remove|take|out|from|delete|drop|get|rid|of|minus|the|a|an|my|cart|please|to|in|all|just)$/i;
    const words = text
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]+/gi, " ").trim())
      .filter((w) => w && !ignored.test(w));
    return words.length >= 2 ? words.join(" ") : null;
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

      // A comparison turn opened several products in one assistant message, so
      // the reply is built from every result of that turn rather than the last
      // one — otherwise the shopper would only ever hear about the final item.
      const comparison = this.composeComparison(messages);
      if (comparison) return { message: { role: "assistant", content: comparison } };

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

  /**
   * Speak a side-by-side comparison when the previous assistant turn asked for
   * more than one product. Each line is built only from what the tools returned,
   * so nothing about either product is invented here.
   *
   * The turn's messages are the assistant message carrying the tool calls
   * followed by one tool result per call, so the assistant message has to be
   * located by scanning back rather than assumed to be the previous message.
   */
  private composeComparison(messages: ChatRequest["messages"]): string | null {
    let assistantAt = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && (messages[i].tool_calls ?? []).length >= 2) {
        assistantAt = i;
        break;
      }
    }
    if (assistantAt < 0) return null;

    const calls = messages[assistantAt].tool_calls!;
    if (!calls.every((c) => c.function.name === "getProduct")) return null;

    const lines: string[] = [];
    for (const [i, call] of calls.entries()) {
      const resultMessage = messages
        .slice(assistantAt + 1)
        .find((m) => m.role === "tool" && m.tool_call_id === call.id);
      if (!resultMessage) return null;
      let result: ToolResult;
      try {
        result = JSON.parse(resultMessage.content) as ToolResult;
      } catch {
        return null;
      }
      const product = result.data?.product as
        | { name?: string; priceLabel?: string; rating?: number; reviewCount?: number; appearance?: { summary?: string } }
        | undefined;
      if (!product?.name) return null;
      const looks = product.appearance?.summary
        ? ` It looks ${lowerFirst(product.appearance.summary).replace(/\.$/, "")}.`
        : " The catalog doesn't describe how it looks.";
      lines.push(
        `Option ${i + 1}, ${product.name}, ${product.priceLabel ?? ""}, rated ${product.rating ?? "?"} from ${product.reviewCount ?? "?"} reviews.${looks}`
      );
    }
    return `${lines.join(" ")} Which one would you like to go with?`;
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

  /** One assistant turn, several tool calls at once (used to compare options). */
  private emitMany(calls: Array<{ name: string; args: Record<string, unknown> }>): ChatResponse {
    for (const c of calls) this.history.push({ phase: "emit", note: `${c.name} ${JSON.stringify(c.args)}` });
    const stamp = Date.now();
    return {
      message: {
        role: "assistant",
        content: "",
        tool_calls: calls.map((c, i) => ({
          id: `call_${stamp}_${i}`,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
    };
  }

  /**
   * Every distinct option the user named, in the order they named them, so
   * "compare the first and second options" opens both products. Ordinals are
   * read in ascending order because a comparison is only meaningful that way.
   */
  private resolveMultipleReferents(text: string, ids: string[]): string[] {
    const order: Record<string, number> = {
      first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3,
    };
    const found = new Set<number>();
    for (const word of text.toLowerCase().split(/\s+/)) {
      const idx = order[word.replace(/[^a-z0-9]+/g, "")];
      if (idx !== undefined && ids[idx]) found.add(idx);
    }
    return [...found].sort((a, b) => a - b).map((i) => ids[i]);
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
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export { config, formatPrice };