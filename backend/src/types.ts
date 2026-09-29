// Shared domain types for EchoLabs (backend).

export const CATEGORIES = [
  "Electronics",
  "Jewelry",
  "Men's Clothing",
  "Women's Clothing",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * How a product LOOKS, described in trusted catalog prose at seed time so a
 * blind shopper gets the same visual detail a sighted one would take from the
 * photo. Every field is optional: the shape has to fit electronics, jewelry
 * and clothing alike, and a product may simply be missing some of it.
 *
 * This is deliberately NOT a bag of visual words the LLM must assemble: it is
 * the catalog's own answer, so nothing here is ever inferred from a name, a
 * photo, or a previous answer at runtime. Absent means "not specified", and
 * the agent says exactly that rather than filling the gap.
 *
 * Keep it separate from `keySpecs`: specs are the FUNCTIONAL, verifiable facts
 * (fabric weight, screen size, carat), while this is only how it presents.
 * "Looks like leather" must never become "made of leather".
 */
export interface ProductAppearance {
  /** "ivory", "gunmetal", "multicolour" — always speakable, never a hex code. */
  primaryColor?: string;
  secondaryColors?: string[];
  pattern?: string; // "small floral", "solid", "pinstripe"
  /** Shape-defining construction: neckline, sleeves, collar, closure, fit. */
  details?: string[];
  /** How the surface reads: "brushed", "glossy", "matte", "chunky knit". */
  texture?: string;
  /** 1-3 adjectives the shopper would actually use: "minimal", "edgy". */
  styleImpression?: string;
  /** The one line a person would say out loud to describe it on sight. */
  summary?: string;
}

export interface Product {
  id: string;
  name: string;
  category: Category;
  price: number;
  stock: number;
  rating: number;
  reviewCount: number;
  keySpecs: string[]; // max 3
  description: string;
  /**
   * Trusted visual description of the product. Optional on purpose: absence
   * means the catalog simply doesn't describe how this item looks, and the
   * agent says "I don't have that detail" rather than inventing one. Nothing
   * is ever derived from an image at request time.
   */
  appearance?: ProductAppearance;
}

export interface ProductFilter {
  category?: string;
  maxPrice?: number;
  minRating?: number;
  q?: string;
  limit?: number;
  /** Cursor for pagination - the productId to start after (exclusive) */
  cursor?: string;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  id: string;
  sessionId: string;
  items: CartItem[];
  /** APPROVED addition (see plan decision): home for the applied coupon. */
  couponCode: string | null;
  discountPercent: number;
}

export interface Coupon {
  id: string;
  code: string;
  discountPercent: number;
  active: boolean;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  priceAtOrder: number;
}

export interface Order {
  id: string;
  sessionId: string;
  items: OrderItem[];
  couponApplied: { code?: string; discountPercent?: number } | null;
  total: number;
  status: "confirmed";
  createdAt: string | null;
}

export interface LastAction {
  type: string;
  [key: string]: unknown;
}

export interface ConversationSession {
  id: string;
  sessionId: string;
  /** THE only product ids a model may reference this turn. Most-recent-first. */
  recentProductIds: string[];
  lastAction: LastAction | null;

  // --- Extended conversational memory fields ---
  /** The product currently being discussed (for follow-up questions). */
  currentProductId?: string | null;
  /** The most recent search query for context. */
  recentSearchQuery?: string | null;
  /** The category of the recent search. */
  recentCategory?: string | null;
  /** The inferred intent of the recent interaction. */
  recentIntent?: string | null;
  /** Bounded history of product references with context (max 10). */
  recentProductReferences?: Array<{
    productId: string;
    context: string;
    timestamp: number;
  }>;
  /** Bounded conversation turn count. */
  turnCount?: number;
}

/** Standard envelope every tool returns. */
export interface ToolResult {
  success: boolean;
  message: string;
  error?: string;
  data?: Record<string, unknown>;
}

/** Interface implemented identically by MemoryStore (placeholder) and MongoStore. */
export interface Store {
  init(): Promise<Store>;
  reset(): Promise<Store>;

  searchProducts(filter: ProductFilter): Promise<Product[]>;
  allProducts(): Promise<Product[]>;
  getProductById(id: string): Promise<Product | null>;
  getProductsByIds(ids: string[]): Promise<Product[]>;

  getCart(sessionId: string): Promise<Cart | null>;
  getOrCreateCart(sessionId: string): Promise<Cart>;
  saveCart(cart: Cart): Promise<Cart>;

  findCouponByCode(code: string): Promise<Coupon | null>;

  createOrder(data: Omit<Order, "id" | "createdAt">): Promise<Order>;
  getLatestOrder(sessionId: string): Promise<Order | null>;

  decrementStock(updates: { productId: string; delta: number }[]): Promise<{ productId: string; ok: boolean }[]>;

  getSession(sessionId: string): Promise<ConversationSession | null>;
  getOrCreateSession(sessionId: string): Promise<ConversationSession>;
  saveSession(session: ConversationSession): Promise<ConversationSession>;
}