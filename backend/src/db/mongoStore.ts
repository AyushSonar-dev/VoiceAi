import mongoose from "mongoose";
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
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    await this.seedIfEmpty();
    return this;
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
    return cartShape(doc);
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
    return couponShape(doc);
  }

  // ---------------- orders ----------------
  async createOrder(data: Omit<Order, "id" | "createdAt">): Promise<Order> {
    const doc = await OrderModel.create(data);
    return orderShape(doc.toObject());
  }

  async getLatestOrder(sessionId: string): Promise<Order | null> {
    const doc = await OrderModel.findOne({ sessionId }).sort({ createdAt: -1 }).lean();
    return orderShape(doc);
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
    return sessionShape(doc);
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
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MongoStore requires MONGODB_URI — see db/index.ts before selecting MongoStore.");
  return uri;
}

// Re-exported doc type for the tool layer if needed.
export type { ProductDoc };