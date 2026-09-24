import crypto from "node:crypto";
import { SEED_PRODUCTS } from "../seed/products.js";
import { SEED_COUPONS } from "../seed/coupons.js";
import {
  productShape,
  cartShape,
  couponShape,
  orderShape,
  sessionShape,
  applyProductFilters,
} from "./shape.js";
import type { ProductDoc } from "../models/Product.js";
import type {
  Store,
  Product,
  ProductFilter,
  Cart,
  Coupon,
  Order,
  ConversationSession,
} from "../types.js";

type ProductRow = { _id: string } & Product;
type CouponRow = { _id: string } & Omit<Coupon, "id">;
type CartRow = { _id: string } & Omit<Cart, "id">;
type OrderRow = { _id: string; createdAt: Date } & Omit<Order, "id" | "createdAt">;
type SessionRow = { _id: string } & Omit<ConversationSession, "id">;

/**
 * PLACEHOLDER DATA STORE (clearly marked).
 *
 * Used ONLY while MONGODB_URI is unset, so the system stays fully runnable
 * end-to-end before a real database is provided. It implements the exact same
 * interface as MongoStore with the same seed data — swapping in MongoDB is a
 * one-line config change. Nothing here is used when MONGODB_URI is set.
 */
export class MemoryStore implements Store {
  private products: ProductRow[];
  private coupons: CouponRow[];
  private carts: Map<string, CartRow>;
  private orders: OrderRow[];
  private sessions: Map<string, SessionRow>;

  constructor() {
    this.products = [];
    this.coupons = [];
    this.carts = new Map();
    this.orders = [];
    this.sessions = new Map();
  }

  async init(): Promise<Store> {
    console.warn(
      "[ECHOLABS] PLACEHOLDER STORE: MONGODB_URI not set — using in-memory store seeded at startup. " +
        "Cart/orders/sessions will not persist across restarts. Set MONGODB_URI to enable MongoDB."
    );
    for (const p of SEED_PRODUCTS) {
      const _id = crypto.randomBytes(12).toString("hex");
      this.products.push({ _id, id: _id, ...p });
    }
    for (const c of SEED_COUPONS) {
      this.coupons.push({ _id: crypto.randomBytes(12).toString("hex"), ...c });
    }
    return this;
  }

  async reset(): Promise<Store> {
    this.carts.clear();
    this.orders = [];
    this.sessions.clear();
    return this;
  }

  // ---------------- products ----------------
  async searchProducts(filter: ProductFilter): Promise<Product[]> {
    const products = applyProductFilters(this.products, filter);
    return products.map((p) => productShape(p as unknown as ProductDoc));
  }

  async allProducts(): Promise<Product[]> {
    return this.products.map((p) => productShape(p as unknown as ProductDoc));
  }

  async getProductById(id: string): Promise<Product | null> {
    const doc = this.products.find((p) => p._id === String(id));
    return doc ? productShape(doc as unknown as ProductDoc) : null;
  }

  async getProductsByIds(ids: string[]): Promise<Product[]> {
    const wanted = new Set(ids.map(String));
    return this.products.filter((p) => wanted.has(p._id)).map(productShape);
  }

  // ---------------- carts ----------------
  async getCart(sessionId: string): Promise<Cart | null> {
    return cartShape(this.carts.get(sessionId) ?? null);
  }

  async getOrCreateCart(sessionId: string): Promise<Cart> {
    let cart = this.carts.get(sessionId);
    if (!cart) {
      cart = { _id: crypto.randomBytes(12).toString("hex"), sessionId, items: [], couponCode: null, discountPercent: 0 };
      this.carts.set(sessionId, cart);
    }
    return cartShape(cart);
  }

  async saveCart(cart: Cart): Promise<Cart> {
    const row: CartRow = { _id: cart.id, ...cart };
    this.carts.set(cart.sessionId, row);
    return cartShape(row);
  }

  // ---------------- coupons ----------------
  async findCouponByCode(code: string): Promise<Coupon | null> {
    const doc = this.coupons.find((c) => c.code.toUpperCase() === code.toUpperCase().trim());
    return couponShape(doc!);
  }

  // ---------------- orders ----------------
  async createOrder(data: Omit<Order, "id" | "createdAt">): Promise<Order> {
    const order: OrderRow = { _id: crypto.randomBytes(12).toString("hex"), createdAt: new Date(), ...data };
    this.orders.push(order);
    return orderShape(order);
  }

  async getLatestOrder(sessionId: string): Promise<Order | null> {
    const found = this.orders
      .filter((o) => o.sessionId === sessionId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return orderShape(found!);
  }

  // ---------------- stock ----------------
  async decrementStock(updates: { productId: string; delta: number }[]): Promise<{ productId: string; ok: boolean }[]> {
    const results: { productId: string; ok: boolean }[] = [];
    for (const { productId, delta } of updates) {
      const p = this.products.find((x) => x._id === productId);
      if (!p || p.stock < delta) {
        results.push({ productId, ok: false });
        continue;
      }
      p.stock -= delta;
      results.push({ productId, ok: true });
    }
    return results;
  }

  // ---------------- conversation sessions ----------------
  async getSession(sessionId: string): Promise<ConversationSession | null> {
    return sessionShape(this.sessions.get(sessionId) ?? null);
  }

  async getOrCreateSession(sessionId: string): Promise<ConversationSession> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { _id: crypto.randomBytes(12).toString("hex"), sessionId, recentProductIds: [], lastAction: null };
      this.sessions.set(sessionId, session);
    }
    return sessionShape(session);
  }

  async saveSession(session: ConversationSession): Promise<ConversationSession> {
    const row: SessionRow = { _id: session.id, ...session };
    this.sessions.set(session.sessionId, row);
    return sessionShape(row);
  }
}