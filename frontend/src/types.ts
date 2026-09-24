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
  voiceAgent: boolean;
  llmMode: string;
}

/**
 * Inline session config returned by POST /api/voice/setup. The browser opens a
 * direct WebSocket to wss://agents.assemblyai.com/v1/ws?token=... and sends:
 * { type: "session.update", session } — AssemblyAI then owns STT, LLM, TTS
 * and turn-taking. Our backend only mints the token and serves the config.
 */
export interface VoiceAgentSetup {
  token: string;
  session: {
    system_prompt: string;
    greeting: string;
    tools: Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }>;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  };
}

export interface ToolResult {
  success: boolean;
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
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