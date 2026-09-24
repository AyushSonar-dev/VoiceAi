export interface RecentProduct {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  rating: number;
  reviewCount: number;
  keySpecs: string[];
  inStock: boolean;
}

export interface CartLine {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CartSummary {
  isEmpty: boolean;
  lines: CartLine[];
  subtotal: number;
  discountPercent: number;
  discount: number;
  total: number;
  linesText: string;
  couponCode: string | null;
}

export interface OrderInfo {
  id: string;
  total: number;
  status: string;
}

export interface EchoState {
  sessionId: string;
  cart: CartSummary;
  recentProducts: RecentProduct[];
  lastAction: unknown;
  lastOrder: OrderInfo | null;
}

export interface Capabilities {
  stt: boolean;
  tts: boolean;
  db: string;
  currency: string;
  categories: string[];
}

export type SseEvent =
  | { type: "turn"; payload: { userText: string } }
  | { type: "filler"; payload: { text: string; audioUrl: string | null } }
  | {
      type: "final";
      payload: { reply: string; audioUrl: string | null; state: EchoState };
    }
  | { type: "error"; payload: { message: string } };

export interface TurnEvents {
  userText: string;
  filler: { text: string; audioUrl: string | null } | null;
  reply: string;
  audioUrl: string | null;
  state?: EchoState;
  error?: string;
}