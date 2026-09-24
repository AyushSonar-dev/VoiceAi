import { searchProducts, type SearchProductsParams } from "./searchProducts.js";
import { getProduct, type GetProductParams } from "./getProduct.js";
import { addToCart, type AddToCartParams } from "./addToCart.js";
import { removeFromCart, type RemoveFromCartParams } from "./removeFromCart.js";
import { getCart, type GetCartParams } from "./getCart.js";
import { applyCoupon, type ApplyCouponParams } from "./applyCoupon.js";
import { checkout, type CheckoutParams } from "./checkout.js";
import { ToolError } from "./shared.js";
import type { ToolResult } from "../types.js";

export type ToolHandler = (params: any) => Promise<ToolResult>;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_REGISTRY: Record<string, ToolHandler> = {
  searchProducts: searchProducts,
  getProduct: getProduct,
  addToCart: addToCart,
  removeFromCart: removeFromCart,
  getCart: getCart,
  applyCoupon: applyCoupon,
  checkout: checkout,
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "searchProducts",
      description:
        "Search the catalog with constraints (category, budget, rating) or free-text. Returns at most a couple of options, each with its productId. Use when the user describes what they want to buy or browse. The returned productIds are the ONLY ids you may reference later.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
          category: {
            type: "string",
            enum: ["Electronics", "Jewelry", "Men's Clothing", "Women's Clothing"],
            description: "Optional. One allowed category only.",
          },
          maxPrice: { type: "number", description: "Optional. Maximum budget in the store currency." },
          minRating: { type: "number", description: "Optional. Minimum star rating 0-5." },
          q: { type: "string", description: "Optional. Keywords to match against name/description/specs." },
          purpose: { type: "string", description: "Optional. The user's stated purpose (e.g. gift). Helps scope the search." },
          maxResults: { type: "number", description: "Optional. How many options (default 2, max 4)." },
        },
        required: ["sessionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getProduct",
      description:
        "Fetch full details for a product the user is already discussing. productId must be one the user was handed in the current session (e.g. from searchProducts or getCart).",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
          productId: { type: "string", description: "A productId returned by a tool earlier in this session." },
        },
        required: ["sessionId", "productId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "addToCart",
      description:
        "Add a product to the session cart. productId MUST be one returned by a tool earlier in this session — never invent one. Repeats an identical add are idempotent (no double-add). If the item is out of stock the tool returns a real in-stock alternative to offer.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
          productId: { type: "string", description: "A productId returned by a tool earlier in this session." },
          quantity: { type: "number", description: "Default 1." },
        },
        required: ["sessionId", "productId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "removeFromCart",
      description: "Remove a product (or a quantity of it) from the session cart.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
          productId: { type: "string", description: "The product to remove from the cart." },
          quantity: { type: "number", description: "Omit to remove the whole line." },
        },
        required: ["sessionId", "productId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCart",
      description: "Get the current cart contents and totals for the session.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
        },
        required: ["sessionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyCoupon",
      description: "Validate and apply a coupon code to the session cart. Only valid active codes are applied.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
          code: { type: "string", description: "The coupon code, e.g. WELCOME15." },
        },
        required: ["sessionId", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout",
      description:
        "Start checkout. Call WITHOUT confirm first — it returns a preview you MUST read to the user and ask for explicit confirmation. Only if the user clearly says yes, call again with confirm:true; the backend then creates the order. NEVER call with confirm:true without the user confirming.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The current conversation sessionId." },
          confirm: { type: "boolean", description: "false/omitted = preview only. true = place the order." },
        },
        required: ["sessionId"],
      },
    },
  },
];

/**
 * Dispatch a tool call by name. Returns the ToolResult envelope. ToolError is
 * normalized to a structured failure so the model can respond truthfully.
 */
export async function dispatchTool(name: string, params: Record<string, any>): Promise<ToolResult> {
  const handler = TOOL_REGISTRY[name];
  if (!handler) {
    return { success: false, error: "unknown_tool", message: `Tool "${name}" does not exist.`, data: {} };
  }
  try {
    return await handler(params ?? {});
  } catch (err) {
    if (err instanceof ToolError) {
      return { success: false, error: err.code, message: err.message, data: {} };
    }
    console.error(`[ECHOLABS] tool ${name} crashed`, err);
    return {
      success: false,
      error: "internal",
      message: "Something went wrong on my side. Please ask me to try again.",
      data: {},
    };
  }
}

/**
 * Voice Agent API tool schema (flat `{type,name,description,parameters}`, no
 * OpenAI `function` wrapper) with the internal `sessionId` parameter stripped:
 * the agent never sees it — the relay (browser/script) injects it before the
 * call reaches the Express tool gateway, where session-scoped validation lives.
 *
 * Names are snake_case verb-noun and descriptions name their triggers per the
 * AssemblyAI tool-calling guidance ("call this when...", "when in doubt, call
 * the tool") — the managed LLM's main signal for when to fire a tool.
 */
export const VOICE_AGENT_TOOL_NAME_MAP: Record<string, string> = {
  search_products: "searchProducts",
  get_product: "getProduct",
  add_to_cart: "addToCart",
  remove_from_cart: "removeFromCart",
  get_cart: "getCart",
  apply_coupon: "applyCoupon",
  checkout: "checkout",
};

type VoiceAgentToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

function voaTool(
  snakeName: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): VoiceAgentToolDefinition {
  return {
    type: "function",
    name: snakeName,
    description,
    parameters: { type: "object", properties, required },
  };
}

export const VOICE_AGENT_TOOL_DEFINITIONS: VoiceAgentToolDefinition[] = [
  voaTool(
    "search_products",
    "Search the EchoLabs catalog (Electronics, Jewelry, Men's Clothing, Women's Clothing) with optional category, budget, rating or keywords. Returns 1-4 real products, each with a genuine productId. Call this whenever the user asks to find, browse, buy, or show something (e.g. 'bracelets', 'rings under 2500', 'a gift'). When in doubt, call this — do not answer from memory.",
    {
      category: {
        type: "string",
        enum: ["Electronics", "Jewelry", "Men's Clothing", "Women's Clothing"],
        description: "Optional. One allowed category only.",
      },
      maxPrice: { type: "number", description: "Optional. Maximum budget in the store currency, e.g. 2500." },
      minRating: { type: "number", description: "Optional. Minimum star rating 0-5." },
      q: { type: "string", description: "Optional. Keywords to match against name/description/specs, e.g. 'ring'." },
      purpose: { type: "string", description: "Optional. The user's stated purpose, e.g. 'gift'. Helps scope the search." },
      maxResults: { type: "number", description: "Optional. How many options (default 2, max 4)." },
    },
    []
  ),
  voaTool(
    "get_product",
    "Fetch full details for one product the user is already discussing. Use only productId values a previous tool result returned this session — never invent one. Call this when the user asks about a specific item that was already shown.",
    {
      productId: { type: "string", description: "A productId from a search_products or get_cart result earlier in this session." },
    },
    ["productId"]
  ),
  voaTool(
    "add_to_cart",
    "Add a productId (from a previous tool result this session) to the cart. Idempotent — a repeat add does not double the line. If out of stock, the result carries a real in-stock alternative to offer. Call this when the user asks to add/buy/put something in the cart.",
    {
      productId: { type: "string", description: "A productId returned by a tool earlier in this session." },
      quantity: { type: "number", description: "Default 1." },
    },
    ["productId"]
  ),
  voaTool(
    "remove_from_cart",
    "Remove a line (or a quantity of it) from the cart. productId must come from a previous get_cart result this session. Call when the user asks to remove/take out something.",
    {
      productId: { type: "string", description: "A productId currently in the cart (from a get_cart result)." },
      quantity: { type: "number", description: "Omit to remove the whole line." },
    },
    ["productId"]
  ),
  voaTool(
    "get_cart",
    "Return the cart lines, coupon and totals. Call when the user asks 'what's in my cart', before/after changes, and before the checkout preview.",
    {},
    []
  ),
  voaTool(
    "apply_coupon",
    "Validate and apply a coupon code to the cart. Only valid active codes apply; the result says exactly which. Call when the user gives a code — e.g. WELCOME15, SAVE10, VIP20, FLASH25.",
    {
      code: { type: "string", description: "The coupon code exactly as spoken, e.g. 'WELCOME15'." },
    },
    ["code"]
  ),
  voaTool(
    "checkout",
    "Start checkout in two steps. FIRST call without confirm: read the returned preview (items, coupon if any, total) aloud and ask for an explicit yes. ONLY after the user clearly confirms, call again with confirm:true — the backend creates the order then. Never call with confirm:true without explicit confirmation.",
    {
      confirm: { type: "boolean", description: "false/omitted = preview only. true = place the order (only after the user explicitly confirmed)." },
    },
    []
  ),
];

export {
  searchProducts,
  getProduct,
  addToCart,
  removeFromCart,
  getCart,
  applyCoupon,
  checkout,
};
export type {
  SearchProductsParams,
  GetProductParams,
  AddToCartParams,
  RemoveFromCartParams,
  GetCartParams,
  ApplyCouponParams,
  CheckoutParams,
};