import mongoose from "mongoose";
import { config } from "../config.js";
import { Product as ProductModel, type ProductDoc } from "../models/Product.js";
import { Cart as CartModel } from "../models/Cart.js";
import { Coupon as CouponModel } from "../models/Coupon.js";
import { Order as OrderModel } from "../models/Order.js";
import { ConversationSession as SessionModel } from "../models/ConversationSession.js";
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
import type { Store, Product, ProductFilter, Cart, Coupon, Order, ConversationSession } from "../types.js";

const toStr = (v: unknown): string => String(v);

export class MongoStore implements Store {
  async init(): Promise<Store> {
    const uri = configUri();
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      await this.seedIfEmpty();
      await this.backfillAppearance();
      return this;
    } catch (err) {
      // Never leave a half-open connection behind for the caller to trip over
      // if the database is unreachable: let the store factory decide what to do.
      await mongoose.disconnect().catch(() => {});
      throw err;
    }
  }

  async reset(): Promise<Store> {
    await mongoose.connection.dropDatabase();
    await this.seedIfEmpty();
    return this;
  }

  private async seedIfEmpty(): Promise<void> {
    const products = await ProductModel.estimatedDocumentCount();
    if (products === 0) {
      await ProductModel.insertMany(SEED_PRODUCTS.map((p) => ({ ...p, keySpecs: p.keySpecs.slice(0, 3) })));
      console.log(`[ECHOLABS] Seeded ${SEED_PRODUCTS.length} products into MongoDB.`);
    }
    const coupons = await CouponModel.estimatedDocumentCount();
    if (coupons === 0) {
      await CouponModel.insertMany(SEED_COUPONS);
      console.log(`[ECHOLABS] Seeded ${SEED_COUPONS.length} coupons into MongoDB.`);
    }
  }

  // ---------------- products ----------------
  /**
   * Catalogs seeded before visual `appearance` existed still load fine (the
   * field is optional), so fill it in on boot rather than asking anyone to
   * re-seed. Only documents missing it are touched, and never with a guess:
   * this copies what the catalog actually states, or leaves the product alone.
   */
  private async backfillAppearance(): Promise<void> {
    const missing = { appearance: { $exists: false } };
    const stale = await ProductModel.find(missing, { name: 1 }).lean();
    if (!stale.length) return;
    const names = new Set(stale.map((d) => d.name));
    const ops = SEED_PRODUCTS.filter((p) => names.has(p.name) && p.appearance).map((seed) => ({
      updateOne: {
        filter: { name: seed.name, ...missing },
        update: { $set: { appearance: seed.appearance } },
      },
    }));
    if (!ops.length) return;
    const res = await ProductModel.bulkWrite(ops, { ordered: false });
    console.log(`[ECHOLABS] Added stored visual appearance to ${res.modifiedCount} existing product(s).`);
  }

  async searchProducts(filter: ProductFilter): Promise<Product[]> {
    const query: Record<string, unknown> = {};
    if (filter.category) query.category = filter.category;
    const docs = await ProductModel.find(query).limit(200).lean();
    return applyProductFilters(docs.map(productShape), filter);
  }

  async allProducts(): Promise<Product[]> {
    const docs = await ProductModel.find({}).lean();
    return docs.map(productShape);
  }

  async getProductById(id: string): Promise<Product | null> {
    const doc = await ProductModel.findById(id).lean();
    return doc ? productShape(doc) : null;
  }

  async getProductsByIds(ids: string[]): Promise<Product[]> {
    const objectIds = ids.filter((id) => mongoose.isObjectIdOrHexString(id));
    if (!objectIds.length) return [];
    const docs = await ProductModel.find({ _id: { $in: objectIds } }).lean();
    const byId = new Map(docs.map((d: ProductDoc) => [toStr(d._id), productShape(d)]));
    return ids.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p));
  }

  // ---------------- carts ----------------
  async getCart(sessionId: string): Promise<Cart | null> {
    const doc = await CartModel.findOne({ sessionId }).lean();
    return doc ? cartShape(doc) : null;
  }

  async getOrCreateCart(sessionId: string): Promise<Cart> {
    let doc = await CartModel.findOne({ sessionId }).lean();
    if (!doc) {
      const created = await CartModel.create({ sessionId, items: [], couponCode: null, discountPercent: 0 });
      return cartShape(created.toObject());
    }
    return cartShape(doc);
  }

  async saveCart(cart: Cart): Promise<Cart> {
    const doc = await CartModel.findOneAndUpdate(
      { sessionId: cart.sessionId },
      {
        $set: {
          items: cart.items,
          couponCode: cart.couponCode ?? null,
          discountPercent: cart.discountPercent ?? 0,
        },
      },
      { new: true, upsert: true }
    );
    return cartShape(doc.toObject());
  }

  // ---------------- coupons ----------------
  async findCouponByCode(code: string): Promise<Coupon | null> {
    const doc = await CouponModel.findOne({ code: code.toUpperCase().trim() }).lean();
    return doc ? couponShape(doc) : null;
  }

  // ---------------- orders ----------------
  async createOrder(data: Omit<Order, "id" | "createdAt">): Promise<Order> {
    const doc = await OrderModel.create(data);
    return orderShape(doc.toObject());
  }

  async getLatestOrder(sessionId: string): Promise<Order | null> {
    const doc = await OrderModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
    return doc ? orderShape(doc) : null;
  }

  // ---------------- stock ----------------
  async decrementStock(updates: { productId: string; delta: number }[]): Promise<{ productId: string; ok: boolean }[]> {
    const results: { productId: string; ok: boolean }[] = [];
    for (const { productId, delta } of updates) {
      const doc = await ProductModel.findOneAndUpdate(
        { _id: productId, stock: { $gte: delta } },
        { $inc: { stock: -delta } },
        { new: false }
      );
      results.push({ productId: toStr(productId), ok: Boolean(doc) });
    }
    return results;
  }

  // ---------------- conversation sessions ----------------
  async getSession(sessionId: string): Promise<ConversationSession | null> {
    const doc = await SessionModel.findOne({ sessionId }).lean();
    return doc ? sessionShape(doc) : null;
  }

  async getOrCreateSession(sessionId: string): Promise<ConversationSession> {
    const doc = await SessionModel.findOne({ sessionId }).lean();
    if (doc) return sessionShape(doc);
    const created = await SessionModel.create({ sessionId, recentProductIds: [], lastAction: null });
    return sessionShape(created.toObject());
  }

  async saveSession(session: ConversationSession): Promise<ConversationSession> {
    const doc = await SessionModel.findOneAndUpdate(
      { sessionId: session.sessionId },
      { $set: { recentProductIds: session.recentProductIds, lastAction: session.lastAction } },
      { new: true, upsert: true }
    );
    return sessionShape(doc.toObject());
  }
}

function configUri(): string {
  // Single source of truth: db/index.ts selects this store based on the same
  // config value, so the two can never disagree about which database is in use.
  const uri = config.mongoUri;
  if (!uri) throw new Error("MongoStore requires MONGODB_URI — see db/index.ts before selecting MongoStore.");
  return uri;
}

// Re-exported doc type for the tool layer if needed.
export type { ProductDoc };