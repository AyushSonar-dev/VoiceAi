# EchoMart — Low-Level Design (LLD)

> Data structures, API contracts, state machines, and implementation notes.

---

## 1. Core Data Structures

### 1.1 Session (backend)
```typescript
interface ConversationSession {
  id: string;                     // UUID v4 (primary key)
  messages: Message[];            // Ordered conversation history (ring buffer, max 50)
  rememberedProductIds: string[]; // Products the agent has seen (deduped, max 20)
  cart: CartLine[];               // Mutable cart state
  couponCode: string | null;      // Active coupon, null if none
  lastAction: Action | null;      // Last tool invoked (used by checkout flow)
  createdAt: Date;
  updatedAt: Date;
}

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;            // Set only for role=tool (result messages)
}
```

**Why a ring buffer for messages?** LLM context windows are finite. Capping at 50
messages prevents runaway token costs while keeping enough history for coherent
multi-turn conversations (typical session: 8–12 turns).

---

### 1.2 Product
```typescript
interface Product {
  id: string;                    // Slug-style: "diamond-tennis-bracelet"
  name: string;
  category: string;              // Enum — see CATEGORIES in types.ts
  price: number;                 // Integer paise / smallest currency unit
  stock: number;
  rating: number;                // 0.0 – 5.0
  reviewCount: number;
  keySpecs: string[];            // Up to 5 short spec strings
  appearance?: ProductAppearance;// Optional visual description for voice & sighted users
}

interface ProductAppearance {
  primaryColor?: string;         // CSS-mappable color name ("gold", "navy", …)
  secondaryColors?: string[];
  pattern?: string;              // "floral", "geometric", …
  details?: string[];            // ["18-karat", "hand-stitched"]
  texture?: string;
  styleImpression?: string;      // "elegant", "sporty"
  summary?: string;              // Full sentence if provided
}
```

---

### 1.3 Cart
```typescript
interface CartLine {
  productId: string;
  name: string;           // Denormalised — survives product catalog changes
  quantity: number;       // Always ≥ 1
  unitPrice: number;
  lineTotal: number;      // unitPrice × quantity (maintained by addToCart / remove)
}

interface CartSummary {
  isEmpty: boolean;
  lines: CartLine[];
  subtotal: number;
  discountPercent: number;  // 0–100; set by applyCoupon
  discount: number;         // Absolute amount deducted
  total: number;
  linesText: string;        // Pre-formatted string for the voice agent
  couponCode: string | null;
}
```

---

### 1.4 Search Cache (in-process)
```
Map<string, { items: Product[]; expiresAt: number }>

Key  : JSON({ c, p, r, q, l }) — sorted, deterministic
Value: Product array + epoch-ms expiry (TTL = 60 000 ms)
Eviction: lazy (on read) + proactive scan at 128-entry threshold
```

**Why not Redis?** For a hackathon MVP with a single Node process, a plain Map
is zero-latency, zero-dependency, and sufficient. Redis is the correct migration
path for multi-process deployments.

---

## 2. Voice Agent State Machine

```
                      ┌─────────┐
            ─────────►│  idle   │◄────────────────────────────┐
                       └────┬────┘                             │
                     click  │  handleConnect()                 │
                            ▼                                  │
                       ┌──────────────┐                        │
                       │  connecting  │                        │
                       └──────┬───────┘                        │
              session.ready   │                                │
                              ▼                                │
                       ┌──────────────┐   session.end()        │
            ┌─────────►│  listening   │──────────────────►┌───────────┐
            │           └──────┬───────┘                   │deactivating│
            │   reply.done     │  input.speech.started     └─────┬─────┘
            │   (no tools)     │                           560ms │ settle
            │                  ▼                                 │
            │           ┌──────────────┐                         │
            │           │  thinking    │                         │
            │           └──────┬───────┘                         │
            │   reply.audio    │  reply.done (tools)              │
            │                  ├──────────────────►┌──────────┐   │
            │                  │                   │tool exec │   │
            │                  │                   └────┬─────┘   │
            │                  │    tool.result sent    │         │
            │                  │◄───────────────────────┘         │
            │   reply.done     │                                  │
            │   (completed)    ▼                                  │
            │           ┌──────────────┐                          │
            └───────────│  speaking    │                          │
                        └──────┬───────┘                          │
              input.speech.started (interruption)                 │
                               │  player.flush()                  │
                               └─────────────────────────────────►│
                                                             (deactivating)
```

---

## 3. API Contracts

### POST /api/voice/setup
```
Request : {} (no body)
Response: {
  token: string,          // Short-lived AAI Voice Agent token (5 min TTL)
  session: {
    system_prompt: string,
    greeting: string,
    tools: ToolDefinition[],
    input: { format, language_codes, transcription_prompt, keyterms, turn_detection },
    output: { voice, format, volume }
  }
}
Error (503): { error: true, code: "voice_not_configured", demo: true }
Error (502): { error: true, code: "token_mint_failed", detail: string }
```

### POST /api/tools/:name
```
Request : { sessionId: string, ...toolSpecificArgs }
Response: ToolResult {
  success: boolean,
  error?: string,         // Error code if success=false
  message?: string,       // Human-readable, safe to speak
  data?: Record<string, unknown>
}
```

### Tool Definitions

| Tool | Key Parameters | Side Effects |
|---|---|---|
| `searchProducts` | `category?, maxPrice?, minRating?, q?, purpose?` | Writes product IDs to session.rememberedProductIds |
| `getProduct` | `productId` | Reads product; adds to remembered IDs |
| `addToCart` | `productId, quantity?` | Mutates cart |
| `removeFromCart` | `productId` | Mutates cart |
| `getCart` | `sessionId` | Read-only |
| `applyCoupon` | `code` | Sets cart.couponCode + discount |
| `checkout` | `confirm: boolean` | `confirm=false` → preview; `confirm=true` → creates Order |

---

## 4. Turn Detection Parameters

| Parameter | Value | Rationale |
|---|---|---|
| `vad_threshold` | 0.4 | Catches soft speech; stays above typical background noise |
| `min_silence` | 400 ms | End-of-turn signal without cutting trailing syllables |
| `max_silence` | 2500 ms | Hard ceiling before forcing end-of-turn |
| `interrupt_response` | true | Agent yields immediately on user speech |
| `interruption_delay` | 80 ms | Grace window; rejects brief noise without feeling laggy |

---

## 5. Caching Strategy

```
Layer 1 — Product Search Cache (Node.js Map, single process)
  Key    : JSON-serialised search params
  TTL    : 60 s
  Evict  : Lazy (expired reads) + sweep at 128 entries
  Benefit: ~50–200 ms saved per repeated query; eliminates DB call

Layer 2 — Session State (in-memory Map or MongoDB)
  Read   : Every tool call reads the session document
  Write  : After every mutation (addToCart, checkout, …)
  Future : Add Redis for cross-process session sharing

Layer 3 — CDN (not yet deployed)
  Static Next.js assets → Vercel Edge / CloudFront
  API routes: no CDN (stateful, per-session)
```

---

## 6. Database Schema (MongoDB collections)

```
products          : { _id, name, category, price, stock, rating, … }
                    Index: { category: 1 }
                    Index: { name: "text", keySpecs: "text" }  ← full-text search

conversation_sessions : { _id, messages[], cart[], couponCode, rememberedProductIds[], … }
                        Index: { _id: 1 }   (primary)
                        TTL  : 24 h (auto-expire idle sessions)

orders            : { _id, sessionId, lines[], total, status, createdAt }
                    Index: { sessionId: 1 }

coupons           : { code, discountPercent, active }
                    Index: { code: 1 } (unique)
```

---

## 7. Frontend Module Map

```
src/
├── app/
│   ├── layout.tsx         Bootstrap pref script, metadata
│   ├── page.tsx           Renders <EchoApp />
│   └── globals.css        Design tokens + all component styles
├── components/
│   ├── EchoApp.tsx        Root app, all state, store layout + hero + categories
│   ├── AgentCore.tsx      Canvas orb — the single persistent visual object
│   ├── ProductCard.tsx    Card with color swatch, stars, specs, add-to-cart
│   ├── ProductList.tsx    Animated grid of ProductCards
│   ├── CartPanel.tsx      Slide-in cart drawer
│   ├── CheckoutPanel.tsx  Order confirmation
│   ├── Composer.tsx       Mic button + text input
│   ├── ConnectScreen.tsx  Invite / "press to begin" layer
│   ├── Transcript.tsx     Conversation scroll list
│   ├── LiveRegion.tsx     SR-only live region for tool announcements
│   └── AccessibilityControls.tsx  Theme / motion / font size controls
└── lib/
    ├── voiceAgent.ts      WebSocket client — core of the real voice path
    ├── voiceAudio.ts      AudioWorklet capture + PCM16 player
    ├── agentState.ts      Phase machine (idle→connecting→listening→thinking→speaking)
    ├── api.ts             fetch wrappers for all backend endpoints
    ├── audio.ts           Fallback recorder (demo mode)
    ├── transcript.ts      Message history with partial/commit model
    ├── prefs.ts           Persistent user preferences (localStorage)
    ├── session.ts         sessionId persistence
    └── money.ts           Currency formatting
```
