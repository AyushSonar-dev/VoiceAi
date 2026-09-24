// Shared domain types for EchoLabs (backend).

export const CATEGORIES = [
  "Electronics",
  "Jewelry",
  "Men's Clothing",
  "Women's Clothing",
] as const;

export type Category = (typeof CATEGORIES)[number];

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
}

export interface ProductFilter {
  category?: string;
  maxPrice?: number;
  minRating?: number;
  q?: string;
  limit?: number;
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