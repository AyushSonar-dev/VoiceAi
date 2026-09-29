# EchoLabs — Voice Shopping Assistant ("Echo")

A voice-first shopping assistant built for **blind and low-vision shoppers**. You press one
control, speak a request, and Echo finds products, adds them to a cart, applies coupons and
checks out — carrying the entire conversation by voice and by screen reader, with no pointer
required at any point.

- **One control, no menus.** The whole app is driven by voice. Every button also accepts a click,
  and a click is *converted into a spoken turn* — the backend genuinely cannot tell the two apart.
- **The browser talks directly to AssemblyAI's Voice Agent** over a WebSocket, using a short-lived
  token minted by our backend. No audio ever touches our server, and no API key ever reaches the client.
- **The backend is a tool gateway, not a chatbot.** It owns the catalog, cart, coupons and orders.
  Every state change — whether it came from a human voice, an LLM, a button, or a test — goes
  through one endpoint: `POST /api/tools/:name`.
- **It degrades instead of crashing.** No MongoDB? It runs on an in-memory store. No LLM key? A
  rule-based brain drives the *real* agent loop. No AssemblyAI key? A typed/SSE demo path still works.

---

## Table of contents

1. [Why this exists](#why-this-exists)
2. [Quick start](#quick-start)
3. [Architecture](#architecture)
4. [Flow of execution](#flow-of-execution)
5. [The tool gateway](#the-tool-gateway)
6. [The agent loop](#the-agent-loop)
7. [LLM provider layer](#llm-provider-layer)
8. [Data layer](#data-layer)
9. [Project layout](#project-layout)
10. [API reference](#api-reference)
11. [Environment variables](#environment-variables)
12. [Scripts](#scripts)
13. [Testing](#testing)
14. [Accessibility decisions](#accessibility-decisions)
15. [Known limitations](#known-limitations)
16. [Troubleshooting](#troubleshooting)

---

## Why this exists

Online shopping assumes you can see a product grid, hover to compare, and click through nested
menus. That assumption excludes a large population entirely, and voice assistants usually inherit
it — they are bolted onto a visual storefront rather than designed as one.

Echo is designed in the opposite direction. The screen is nearly empty by default: a single
animated core, a transcript, and whatever the last result was. Everything is reachable by voice,
and everything that matters is announced through a proper `aria-live` region, because a
screen-reader user cannot be shown a "success" state that only exists as a green border.

Design consequences that run through the whole codebase:

- **No product photographs.** Products carry a hand-authored `appearance` block in the catalog
  (primary colour, pattern, sleeve/cut, texture) instead of an image. This means the assistant
  can *speak* about what something looks like using data it actually has, and a model can never
  hallucinate a visual detail. See [`backend/test/appearance.test.ts`](backend/test/appearance.test.ts),
  which enforces this.
- **No pointer-only interaction.** Cart, product and checkout actions are all reachable by voice.
- **A failed action is spoken honestly.** The tool loop is structurally incapable of claiming an
  action succeeded before the backend confirmed it.

---

## Quick start

### Prerequisites

- **Node.js ≥ 20** (root `package.json` `engines`; `tsx` and the `node:test` runner both need it)
- **npm 10+** (uses workspaces)
- Optional: a MongoDB Atlas connection string, AssemblyAI key, ElevenLabs key, and an OpenAI *or*
  Gemini key. **All are optional** — the app runs fully with none of them.

### Install

```bash
git clone <your-fork-url>
cd VoiceAi
npm install          # installs both workspaces (backend, frontend)
```

### Configure

```bash
cp .env.example .env
```

Everything is optional. With an empty `.env` the app boots, seeds 40 products and 5 coupons into an
in-memory store, and serves the typed demo conversation. Fill in keys to unlock more:

| To enable | Set |
| --- | --- |
| Real persistence | `MONGODB_URI` |
| Live voice (STT + LLM + TTS + turn-taking) | `ASSEMBLYAI_API_KEY` |
| Spoken replies in demo mode | `ELEVENLABS_API_KEY` |
| A real LLM instead of the rule-based brain | `OPENAI_API_KEY` or `GEMINI_API_KEY` |

`.env.example` is the authoritative reference. Note that `backend/.env` (gitignored, local only)
is read as a fallback — see [Environment variables](#environment-variables).

### Run

```bash
npm run dev
```

That single command starts **both** processes via [`scripts/dev.mjs`](scripts/dev.mjs), which
pre-checks the ports, gives each child a colour-coded log prefix, and stops both on `Ctrl+C`.

- Frontend: <http://localhost:3000>
- Backend: <http://localhost:4000>

Verify the backend is up:

```bash
curl http://localhost:4000/api/health
# {"ok":true}

curl http://localhost:4000/api/capabilities
# {"db":"memory","stt":true,"tts":true,"llm":true,
#  "llmMode":"assemblyai-voice-agent","voiceAgent":true,
#  "llmProvider":"openai","currency":"₹",
#  "categories":["Electronics","Jewelry","Men's Clothing","Women's Clothing"]}
```

`voiceAgent` is the field the frontend reads to decide which conversation path to open.

### Try the conversation

Open <http://localhost:3000>, press the core, and say:

> "Find me some bracelets" → "Add the first one" → "What's in my cart?" →
> "Apply WELCOME15" → "Check out" → "Yes, place the order"

If you have no keys at all, type those into the composer instead — the demo path accepts text.

### Run without the UI

```bash
npm run demo     # keyless end-to-end conversation against the real gateway
npm run seed     # verify the catalog is loaded
```

`npm run demo` boots the real Express server on an ephemeral port, drives a scripted conversation
through the **real** `runTurn()` over the **real** HTTP gateway, and prints the resulting cart and
order. It needs no database and no API key — with an empty `.env` it runs the whole thing on the
in-memory store and the `PlaceholderBrain`.

It does use your keys *if you have them*, which is the intended way to see the real model. Note that
a **present-but-unusable** key is worse than no key: the demo will try the real provider and throw
rather than fall back to the placeholder (see [Troubleshooting](#troubleshooting)).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER  (Next.js 15 App Router client, React 19)                       │
│                                                                          │
│   EchoApp ──▶ AgentCore (canvas)   Transcript   CartPanel   Composer     │
│      │                                                                   │
│      ├── lib/api.ts  ──── fetch("/api/…")  (relative paths ONLY)          │
│      ├── lib/voiceAgent.ts   ── WebSocket ─────────────┐                  │
│      └── lib/voiceAudio.ts   ── getUserMedia / AudioWorklet (PCM16)       │
└──────┼─────────────────────────────────────────────────┼──────────────────┘
       │                                                 │
       │  same-origin /api/*                             │  wss://agents.assemblyai.com
       │  (Next rewrites; no backend URL in the client)   │  /v1/ws?token=<short-lived>
       ▼                                                 ▼
┌──────────────────────────────┐        ┌────────────────────────────────────┐
│  Next.js server             │        │  ASSEMBLYAI VOICE AGENT             │
│  next.config.mjs rewrites:   │        │  owns STT → LLM → TTS → VAD        │
│   /api/*    → :4000/api/*   │        │  audio never touches our servers    │
│   /images/* → :4000/images/*│        └──────────────┬─────────────────────┘
└──────────┬───────────────────┘                       │ tool.call / tool.result
           │                                           │
           ▼                                           │ (browser relays)
┌──────────────────────────────────────────────────────────────────────────┐
│  EXPRESS BACKEND  —  "the tool gateway"                (port 4000)        │
│                                                                          │
│   routes/     session · state · capabilities · tools · voice             │
│   tools/      7 handlers ── THE ONLY surface that mutates state          │
│   agent/      runTurn()  ←─ LLM tool-use loop (OpenAI wire protocol)     │
│   db/         Store interface ── MongoStore | MemoryStore                │
│   seed/       40 products · 5 coupons                                   │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
            ┌──────────────┐      ┌─────────────────┐
            │  MongoDB     │      │  MemoryStore    │
            │  (Mongoose)  │      │  (fallback)     │
            └──────────────┘      └─────────────────┘
```

### The three decisions that shape everything

**1. The browser holds no secret and no backend URL.** Every client call is a relative `/api/...`
path. `next.config.mjs` rewrites those to `http://127.0.0.1:4000` server-side. The AssemblyAI
WebSocket URL is the only external URL in the frontend, and it carries a short-lived token minted
server-side — the real API key never leaves the backend.

**2. Audio is a client↔AssemblyAI concern, not a backend concern.** Our backend does not run a
transcription loop, an LLM loop, or a TTS loop for the live path. It mints a token
(`POST /api/voice/setup`) and serves the tool gateway the agent calls. This is why the backend has
no WebSocket server at all.

**3. One door to state.** `POST /api/tools/:name` is the only endpoint that mutates anything. The
in-process agent loop reaches it *over real HTTP* via `httpToolGateway()`
([`backend/src/agent/agent.ts:91`](backend/src/agent/agent.ts#L91)) rather than calling the
handlers in-process. The demo script, the unit tests, the hosted Voice Agent and the UI therefore
exercise the identical code path.

---

## Flow of execution

### Path A — Live Voice Agent (the default when `ASSEMBLYAI_API_KEY` is set)

```
 1. Boot            GET /api/capabilities ──▶ { voiceAgent: true, … }
                    POST /api/session      ──▶ { sessionId: "…" }
                    GET /api/state/:id     ──▶ restore cart + last order

 2. Press the core  POST /api/voice/setup ──▶ backend mints token
                                                 POST {VOICE_AGENT_HOST}/v1/token
                                                 (Bearer ASSEMBLYAI_API_KEY)
                                               ◀── { token, session: { system_prompt,
                                                       greeting, tools, input, output } }

 3. Connect        browser ──WebSocket──▶ wss://agents.assemblyai.com/v1/ws?token=…
                    browser ──▶ session.update (the config from step 2)
                    browser ◀── session.ready

 4. Speak          mic → AudioWorklet → downsample 48k→24k mono → PCM16
                    ──────────────────▶ agent (STT, VAD, turn detection)
                    ◀────────────────── transcript.user.delta  (live, in the UI)

 5. The agent acts AssemblyAI's LLM decides it needs the catalog:
                        ◀── tool.call { name: "search_products", args: {…} }
                    browser relay injects sessionId, then:
                        POST /api/tools/search_products  { …args, sessionId }
                            backend/src/routes/tools.ts  maps snake_case → camelCase
                            backend/src/tools/searchProducts.ts  validates + queries
                            Mongo / Memory store
                        ◀── { success: true, data: { options: [{ productId: … }] } }
                        ──▶ tool.result   (the agent genuinely waits for this)

 6. Speak back     ◀── transcript.agent.delta / reply.audio (PCM16 chunks)
                    audio → 24 kHz AudioBuffer, scheduled back-to-back
                    RMS meter drives the core's audio-reactive shading

 7. UI refresh     GET /api/state/:sessionId ──▶ cart, recentProducts,
                    lastAction, lastOrder re-render; a voice-changed cart
                    is announced via a dedicated sr-only live region
```

The browser is the relay, not the orchestrator. The agent decides *what* to call; the backend
decides whether it is allowed to happen.

### Path B — Keyless demo (when `ASSEMBLYAI_API_KEY` is unset)

```
 1. Type or record audio → POST /api/voice  { sessionId, text? | audioBase64? }

 2. Backend HARD-REFUSES if the AssemblyAI key IS set (409 use_voice_agent),
    so the hand-rolled path can never silently run in real mode.

 3. text taken as-is, or audio → transcribeAudio() (AssemblyAI STT)
        │  SSE frame 1:  { type: "turn",    payload: { userText } }

 4. runTurn()  ── LLM emits a tool call
        │        ── dispatch → POST http://127.0.0.1:4000/api/tools/:name
        │  on the first tool call, a filler is synthesised and streamed so the
        │  user isn't left in silence:
        │  SSE frame 2:  { type: "filler",  payload: { text, audioUrl } }

 5. LLM writes the reply, built from the tool results it was given
        │  SSE frame 3:  { type: "final",   payload: { reply, audioUrl, state } }
        └─ or  { type: "error", payload: { message } }
```

`api.ts` reads the SSE stream incrementally with `res.body.getReader()` and splits frames on
`\n\n`, which is why the "let me check that" filler can be *spoken* while the tools are still
running.

### Path C — Inside `runTurn()` (the tool-use loop)

```
       ┌─────────────────┐
       │ buildSystemPrompt│  session's referencable ids + 16 hard rules
       └────────┬────────┘
                ▼
   messages = [system, user]
                │
        ┌───────┴────────────────────────────────┐
        │ for turn in 0 .. MAX_LOOP_TURNS-1 (6)  │
        └───────┬────────────────────────────────┘
                ▼
        llm.chat({ messages, tools })
                │
        ┌───────┴──────────────────────┐
        │ no tool_calls?              │──yes──▶ return the model's content
        └───────┬──────────────────────┘
                │ tool_calls
                ▼
        for each tool call:
          parse JSON args
          args.sessionId = <injected, never model-supplied>
          dispatch(name, args)  ── HTTP ──▶ POST /api/tools/:name
                │                            │
                │                   ┌────────┴─────────┐
                │                   │ 7 tool handlers  │
                │                   │ validation,      │
                │                   │ session scoping, │
                │                   │ idempotency,     │
                │                   │ stock guards     │
                │                   └────────┬─────────┘
                │                            ▼
                │                   ToolResult { success, error?, message, data }
                │                   ── ALWAYS surfaced verbatim, success or not
                ▼
          messages.push({ role: "tool", tool_call_id, content: JSON.stringify(result) })
                │  ── loop back; the model may call another tool ──
                │
        ┌───────┴──────────────┐
        │ still going after 6? │──yes──▶ LOOP_EXHAUSTED_REPLY ("nothing changed")
        └──────────────────────┘         + exhausted: true
```

The structural guarantee, from [`backend/src/agent/agent.ts`](backend/src/agent/agent.ts): there is
**no code path that returns a spoken reply while a tool call is still in flight**, and a non-success
result is appended to the conversation exactly as received. The model cannot claim an action
happened before the backend confirmed it, because the code that would let it does not exist.

---

## The tool gateway

`POST /api/tools/:name` — the only surface that mutates state. Handler:
[`backend/src/routes/tools.ts:12`](backend/src/routes/tools.ts#L12). Always answers HTTP 200 with
a `ToolResult` envelope; failures are `{ success: false, error: "<code>", message, data: {} }`.

| Tool | Voice Agent name | What it does |
| --- | --- | --- |
| `searchProducts` | `search_products` | Category / budget / rating / free-text search. Returns 1–4 numbered options. |
| `getProduct` | `get_product` | Full detail for a referencable id, including the catalog's `appearance`. |
| `addToCart` | `add_to_cart` | Adds a line; idempotent; returns a real in-stock alternative when sold out. |
| `removeFromCart` | `remove_from_cart` | Removes a line or a quantity; also accepts a spoken product name. |
| `getCart` | `get_cart` | Lines, coupon, subtotal, discount, total. |
| `applyCoupon` | `apply_coupon` | Validates and applies a code; suggests the active ones on failure. |
| `checkout` | `checkout` | Two-phase: preview, then `confirm: true`. |

### Four invariants

These are enforced in code (not just in the prompt) and are covered by
[`backend/test/tools.test.ts`](backend/test/tools.test.ts):

**1. Referential scoping — `assertReferencable()`**
([`backend/src/tools/shared.ts`](backend/src/tools/shared.ts))
The model may only act on ids it was *handed*. `ConversationSession.recentProductIds` is the
allowlist; `searchProducts`, `getProduct` and `getCart` add to it, and every other tool checks
against it. Asking about a product the session never saw returns `invalid_product_reference`
instead of a guess. This is what makes "the second one" and "it" resolvable without hallucination.

**2. Idempotency**
Repeating an identical `addToCart` immediately after the same add is a no-op, via `lastAction`
on the session. A *different* quantity is a real change and merges (1 → 2 → 3).

**3. Truthful failure**
A failed tool returns a specific error code and a human sentence. The loop appends it verbatim.
Out-of-stock adds return a genuine same-category in-stock `alternative` rather than a bare refusal,
and `applyCoupon` on a bad code lists the codes that would work.

**4. Checkout is two-phase**
`checkout` without `confirm: true` re-validates every line's stock and returns a preview, creating
nothing. Only `confirm: true` creates the order, decrements stock and clears the cart. If a stock
decrement fails mid-flight it returns `stock_changed_during_checkout` rather than claiming success.

---

## The agent loop

Two implementations of the same `Llm` interface ([`backend/src/agent/llm/types.ts`](backend/src/agent/llm/types.ts)):

**`OpenAiClient`** — the real one, speaking the OpenAI wire protocol (`chat.completions`, `tools`,
`tool_choice: "auto"`). Vendor-agnostic by construction: Gemini's OpenAI-compatibility endpoint and
Ollama both work by changing only `{apiKey, baseUrl, model}`.

**`PlaceholderBrain`**
([`backend/src/agent/placeholderBrain.ts`](backend/src/agent/placeholderBrain.ts)) — a rule-based
`Llm` used when no LLM key is configured. It classifies intent by regex, resolves referents
("the first one" → Option N, "it" → the product in `lastAction`), extracts search params, and
chains follow-ups. Crucially, **its replies are built from the tool result's `message` field**, so
it cannot fabricate an outcome either. This is what lets the demo and the whole test suite run
keyless and offline.

`runTurn()` is injectable (`dispatch`, `llm`, `gatewayUrl`, `onToolCall`), which is the seam the
tests use to assert loop invariants without any network.

---

## LLM provider layer

[`backend/src/agent/llm/`](backend/src/agent/llm/)

```
LLM_PROVIDER=auto   ──▶  [openai] ──(recoverable error)──▶  [gemini]
LLM_PROVIDER=openai  ──▶  [openai]   (no key ⇒ PlaceholderBrain; never silently
LLM_PROVIDER=gemini  ──▶  [gemini]     switches vendor)
no keys at all       ──▶  PlaceholderBrain  (loud warning, no crash)
```

- **One client, one loop, one tool set.** Both vendors speak the OpenAI protocol, so swapping is a
  credentials change, not a code change.
- **Fallback is per-request, one attempt each.** A mid-conversation OpenAI→Gemini switch still
  executes the real tool correctly; `providers.test.ts` asserts the exact wire sequence.
- **Recoverable vs not.** `401/403/408/429/5xx/529` and transport errors fall back. `400/404/422`
  and `TypeError`/`ReferenceError` do **not** — a malformed request retried against a second vendor
  just doubles the failure. If every provider fails, the *last real error* surfaces.
- **Retries are dropped to 0** when a fallback exists, so one dead vendor costs exactly one attempt.
- **Secret hygiene.** `redactSecrets()` strips `sk-`/`pk-`/`rk-` keys, `AIza…` Google keys, and
  `Authorization`/`bearer`/`token` values, truncating to 300 chars, before anything is logged.
- **A mistyped provider is not fatal.** `normalizeProviderSetting()` maps any unrecognised
  `LLM_PROVIDER` to `auto` — degrade to a working app, never to a boot crash.

---

## Data layer

`Store` ([`backend/src/types.ts`](backend/src/types.ts)) has two implementations, chosen at boot by
[`backend/src/db/index.ts`](backend/src/db/index.ts):

| Condition | Result |
| --- | --- |
| `MONGODB_URI` unset | `MemoryStore` — seeded from the same data, **nothing persists across restarts** |
| `MONGODB_URI` set, reachable | `MongoStore` — seeds 40 products + 5 coupons only when the collection is empty |
| `MONGODB_URI` set, **unreachable** | Loud multi-line warning, then `MemoryStore`, so the site keeps serving |
| …and `REQUIRE_MONGO=true` | Fatal boot error instead (recommended in deployment, where silently losing writes is worse than not starting) |

Both stores share the same search engine (`applyProductFilters` in
[`backend/src/db/shape.ts`](backend/src/db/shape.ts)): category / `maxPrice` / `minRating`
filters, AND-matching free text over name + category + description + keySpecs + appearance prose,
with crude suffix stemming so "dresses" → "dress" and "striped" → "stripes" match. Results sort by
rating → reviewCount → price.

`MongoStore` guards stock with `$inc` + `{ stock: { $gte: delta } }` so a decrement cannot go
negative under concurrency, and always `disconnect()`s on a failed connect so no half-open handle
is left behind.

---

## Project layout

```
VoiceAi/
├── package.json                 npm workspaces: backend, frontend
├── scripts/dev.mjs              port pre-flight + colour-prefixed dual-process dev runner
├── .env.example                 authoritative env reference
│
├── backend/                     Express "tool gateway"  (ESM, TypeScript, no build step)
│   ├── src/
│   │   ├── index.ts             startServer(), Express app, router mounting
│   │   ├── config.ts            env loading + frozen config + formatPrice()
│   │   ├── types.ts             Product, Cart, Coupon, Order, Session, ToolResult, CATEGORIES
│   │   ├── agent/
│   │   │   ├── agent.ts         runTurn() — the real tool-use loop
│   │   │   ├── prompts.ts       16 system-prompt rules, fillers, MAX_LOOP_TURNS = 6
│   │   │   └── llm/             openaiClient · providers · errors · placeholderBrain · types
│   │   ├── db/                  index (factory) · mongoStore · memoryStore · shape (search)
│   │   ├── models/              Mongoose schemas: Product, Cart, Coupon, Order, ConversationSession
│   │   ├── instruments/         assemblyai (STT) · elevenlabs (TTS)
│   │   ├── routes/              session · state · tools · voice
│   │   ├── tools/               the 7 handlers + shared.ts (assertReferencable, idempotency…)
│   │   ├── seed/                40 products · 5 coupons · run.ts
│   │   └── scripts/             demo.ts · verifyOrder.ts · voiceE2E.ts
│   ├── scripts/                 e2e-gemini.ts · gemini-compat-stub.mjs (dev-only, not typechecked)
│   └── test/                    appearance · loop · providers · storeBoot · tools
│
└── frontend/                    Next.js 15 App Router, single route "/"
    ├── next.config.mjs          /api/* + /images/* rewrites to the backend
    └── src/
        ├── app/                 layout.tsx (pref bootstrap) · page.tsx · globals.css (design system)
        ├── components/          EchoApp (orchestrator) · AgentCore · Transcript · CartPanel ·
        │                        CheckoutPanel · ProductList/Card · Composer · ConnectScreen ·
        │                        AccessibilityControls · LiveRegion
        └── lib/                 api · voiceAgent (WS client) · voiceAudio (PCM) · agentState ·
                                 coreRender · transcript · prefs · money · session · a11y · audio
```

---

## API reference

All endpoints are mounted under `/api` in [`backend/src/index.ts`](backend/src/index.ts).

| Method | Path | Handler | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `index.ts:20` | Liveness probe → `{ ok: true }` |
| `POST` | `/api/session` | `routes/session.ts:9` | Create an anonymous session (UUID) → `{ sessionId }`. No auth. |
| `GET` | `/api/capabilities` | `routes/state.ts:83` | `{ db, stt, tts, llm, llmMode, llmProvider, voiceAgent, currency, categories[] }` — the frontend uses `voiceAgent` to pick its mode. |
| `GET` | `/api/state/:sessionId` | `routes/state.ts:69` | Full UI snapshot: cart summary, `recentProducts`, `lastAction`, `lastOrder`. |
| `POST` | `/api/tools/:name` | `routes/tools.ts:12` | **The tool gateway.** Maps snake_case → camelCase, then dispatches. 7 tools. |
| `POST` | `/api/voice/setup` | `routes/voice.ts:179` | Mints a short-lived AssemblyAI Voice Agent token + inline session config. `503` if unkeyed, `502` if minting fails. |
| `POST` | `/api/voice` | `routes/voice.ts:221` | **Keyless demo fallback (SSE).** `409 use_voice_agent` when the AssemblyAI key *is* set. Streams `turn` / `filler` / `final` / `error`. |

### Example: a full tool call

```bash
# 1. create a session
curl -sX POST http://localhost:4000/api/session
# {"sessionId":"3f1c…"}

# 2. search — note: the returned field is data.items[].id
curl -sX POST http://localhost:4000/api/tools/search_products \
  -H 'content-type: application/json' \
  -d '{"sessionId":"3f1c…","category":"Jewelry","maxPrice":2500}'
# {"success":true,"message":"Found 2 products: …","data":{"items":[
#   {"index":1,"id":"172e91…","name":"Silver Crescent Necklace","price":2499,
#    "rating":4.8,"inStock":true,"appearance":{"primaryColor":"silver",…}}, …]}}

# 3. add — the id MUST be one the session was handed, else invalid_product_reference
curl -sX POST http://localhost:4000/api/tools/add_to_cart \
  -H 'content-type: application/json' \
  -d '{"sessionId":"3f1c…","productId":"172e91…","quantity":1}'
# {"success":true,"message":"Done — Silver Crescent Necklace is now in your cart…"}

# 4. checkout, phase 1 (preview only — creates nothing)
curl -sX POST http://localhost:4000/api/tools/checkout \
  -H 'content-type: application/json' -d '{"sessionId":"3f1c…"}'
# {"success":true,"data":{"confirmRequired":true,"preview":{"items":[…],"total":2499}}}

# 5. checkout, phase 2 (places the order)
curl -sX POST http://localhost:4000/api/tools/checkout \
  -H 'content-type: application/json' -d '{"sessionId":"3f1c…","confirm":true}'
# {"success":true,"data":{"orderConfirmed":true,"order":{"orderId":"884c2b…","status":"confirmed"}}}
```

Every response is a `ToolResult`: `{ success, message, data }`, or `{ success: false, error: "<code>",
message, data: {} }` on failure. Errors are *content*, not transport failures — the HTTP status is
always 200 so the model sees a structured result it can respond to.

---

## Environment variables

Read in exactly two files: [`backend/src/config.ts`](backend/src/config.ts) and
[`backend/src/agent/llm/providers.ts`](backend/src/agent/llm/providers.ts).

**Loading order:** repo-root `.env` first, then `backend/.env`, so a local override wins.
`.env.example` is the documented reference; note that the checked-in `backend/.env` has drifted
and is missing several keys below — all of which have safe defaults, so the app works regardless.

### Server & database

| Variable | Default | If empty / unset |
| --- | --- | --- |
| `PORT` | `4000` | Express listens on 4000. Also read by `next.config.mjs` to build the proxy target. |
| `MONGODB_URI` | `""` | In-memory store. Nothing persists across restarts. |
| `REQUIRE_MONGO` | `false` | An unreachable DB degrades to memory. Set `true` to make it fatal. |
| `SELF_ORIGIN` | `http://127.0.0.1:$PORT` | Origin the in-process agent loop uses to reach its own gateway over HTTP. |
| `CURRENCY` | `₹` (U+20B9) | Symbol used in spoken prices; also switches the prompt's wording to "Indian rupees". |

### Live voice (AssemblyAI)

| Variable | Default | If empty / unset |
| --- | --- | --- |
| `ASSEMBLYAI_API_KEY` | `""` | **The master switch.** Unset ⇒ no STT, no live Voice Agent, `voiceAgent: false`, and `POST /api/voice` becomes the SSE demo path. |
| `ASSEMBLYAI_BASE_URL` | `https://api.assemblyai.com` | STT base URL. |
| `VOICE_AGENT_HOST` | `https://agents.assemblyai.com` | Host used to mint the agent token. |
| `VOICE_AGENT_WS_URL` | `wss://agents.assemblyai.com/v1/ws` | Documented for reference; **not read at runtime** (the host is hardcoded in the client). |
| `VOICE_TOKEN_TTL_SECONDS` | `300` | Token lifetime. |
| `VOICE_MAX_SESSION_SECONDS` | `900` | Max session duration requested from AssemblyAI. |
| `VOICE_ID` | `ivy` | Output voice. |

### Speech (ElevenLabs)

| Variable | Default | If empty / unset |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | `""` | No TTS. Replies return `audioUrl: null`; the browser falls back to `SpeechSynthesis`. |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | Default voice. |
| `ELEVENLABS_MODEL` | `eleven_multilingual_v2` | TTS model. |
| `ELEVENLABS_STABILITY` | `0.4` | Lower = more expressive variation. |
| `ELEVENLABS_SIMILARITY_BOOST` | `0.85` | Higher = closer to the source voice. |
| `ELEVENLABS_STYLE` | `0.6` | Higher = more style exaggeration. |
| `ELEVENLABS_USE_SPEAKER_BOOST` | `true` | Set `false` to disable. |

### LLM

| Variable | Default | If empty / unset |
| --- | --- | --- |
| `LLM_PROVIDER` | `auto` | Unknown values fall back to `auto` rather than crashing. |
| `OPENAI_API_KEY` | `""` | OpenAI skipped. Also gates Ollama/LiteLLM-style gateways. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Only passed to the SDK when explicitly set. Point at Ollama to use a local model. |
| `OPENAI_MODEL` | `gpt-4o-mini` | `LLM_MODEL` is honoured as a legacy alias when this is unset. |
| `GEMINI_API_KEY` | `""` | Gemini skipped. |
| `GEMINI_BASE_URL` | Google's OpenAI-compat endpoint | Override for a proxy. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini chat model. |
| — | — | **No LLM key at all** ⇒ `PlaceholderBrain`, with a loud warning. The app still works. |

### Frontend

Only two, both read at build/dev time in [`frontend/next.config.mjs`](frontend/next.config.mjs):

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_ORIGIN` | — | Full backend origin override, e.g. `http://192.168.1.5:4000`. |
| `BACKEND_PORT` | — | Port only. |

Resolution order: `BACKEND_ORIGIN` → `BACKEND_PORT` → `PORT` parsed out of `backend/.env` →
`http://127.0.0.1:4000`. **There are no `NEXT_PUBLIC_*` variables anywhere**, and no `frontend/.env`.

### Dead entries

`GEMINI_VISION_MODEL` appears in `.env.example` and `backend/.env` but is read by no code — a
leftover from the removed runtime image-description pipeline. Safe to delete.

### Client-side state (`localStorage`)

| Key | Purpose |
| --- | --- |
| `echolabs.sessionId` | Survives reloads so the cart is not lost. |
| `echolabs.theme` | `dark` / `light` / `system`. |
| `echolabs.fontSizePercent` | 85–160%. |
| `echolabs.magnify` | 100 / 125 / 150 / 200%. |
| `echolabs.reducedMotion` | `system` / `on` / `off`. |

All five are read by a blocking inline script in `layout.tsx` **before first paint**, so there is no
flash of the wrong contrast or font size.

---

## Scripts

Run from the repo root.

| Command | Does |
| --- | --- |
| `npm run dev` | Starts backend + frontend together with port pre-flight and colour-prefixed logs. |
| `npm run dev:backend` | Express only, `tsx watch`, port 4000. |
| `npm run dev:frontend` | Next dev only, port 3000. |
| `npm run dev:frontend:clean` | `rm -rf frontend/.next` first — see [Troubleshooting](#troubleshooting). |
| `npm run serve` | Production build + `next start`. |
| `npm run seed` | Verifies the catalog is loaded (printing mode, per-category counts, a sample coupon). |
| `npm run demo` | Keyless end-to-end conversation against the real gateway. **Needs nothing.** *(uses your real LLM keys if they are set)* |
| `npm run typecheck` | `tsc --noEmit` in both workspaces. |
| `npm test` | Backend suites, then frontend suites. |

No ESLint is configured; `npm run lint --workspace=frontend` is an alias of `typecheck`.

Undocumented helpers you can run manually (not wired to npm scripts):

```bash
npx tsx backend/src/scripts/verifyOrder.ts   # read-only: did the last e2e order persist?
npx tsx backend/src/scripts/voiceE2E.ts      # headless real AssemblyAI Voice Agent E2E
npx tsx backend/scripts/e2e-gemini.ts        # 11-step Gemini-only run against a live :4000
```

`voiceE2E.ts` and `e2e-gemini.ts` require real credentials. `voiceE2E.ts` acts as the tool relay
itself and exits non-zero if the agent ever speaks before its `tool.result` arrives.

---

## Testing

Node's built-in `node:test` runner through `tsx`. No Jest, no Vitest, no browser, **no network**.

**Every suite is hermetic** — 4 of 5 backend files force `initStore({ forceMemory: true })`, and the
provider tests spin up local HTTP servers speaking the OpenAI wire protocol rather than mocking.
`npm test` passes with no `.env`, no database and no API keys.

| Suite | Proves |
| --- | --- |
| `backend/test/tools.test.ts` | Each tool's business rules: referential scoping, idempotency, in-stock alternatives, coupon validation, two-phase checkout. |
| `backend/test/loop.test.ts` | `runTurn()` invariants — acts only on handed ids, a failed add is reflected truthfully, "the second one" with no context calls zero tools, checkout confirmation is required. Also drives the loop through the real HTTP gateway and cross-checks `/api/state`. |
| `backend/test/appearance.test.ts` | The 40-product catalog's visual data, that the no-runtime-vision rule holds (no `describe_product_image` tool, no `imageUrl` in any payload, prompts contain no image vocabulary), plus 11 end-to-end conversation tests. |
| `backend/test/providers.test.ts` | Provider selection, env precedence, the exact Gemini wire payload, every recoverable/non-recoverable status, secret redaction, and a mid-conversation OpenAI→Gemini switch. |
| `backend/test/storeBoot.test.ts` | An unreachable `MONGODB_URI` still boots on a *working* memory store; `REQUIRE_MONGO=true` makes it fatal with no half-initialized state. |
| `frontend/test/money.test.ts` | Currency normalisation (the API returns the symbol `"₹"`, not `"INR"`), and that `formatMoney` never throws on hostile input. |
| `frontend/test/transcript.test.ts` | The "reply appears twice" bug — cumulative vs incremental deltas, finals superseding streams, late deltas, interrupted replies. |
| `frontend/test/coreRender.test.ts` | The Agent Core: silhouette never clipped across 9 phases × 4 sizes × 3 DPRs, a distinct profile per phase, a strict size ladder, a <16.7 ms frame budget, audio routed only to the matching phase. |
| `frontend/test/renderPrices.test.ts` | Server-renders `CartPanel` / `CheckoutPanel` / `ProductCard` and asserts real `₹` amounts, no `<img>`, and "No visual description" for undescribed products. |

The pattern worth knowing: risky logic is deliberately extracted into **pure functions**
(`applyWrite`, `resolvePhase`, `renderCoreFrame`, `levelForPhase`, `normalizeCurrency`,
`formatMoney`, `lerpProfile`) precisely so it can be tested with no browser and no DOM.

---

## Accessibility decisions

The design decisions that a reviewer should look at first:

- **Announcements are separated from the conversation.** `Transcript` is a `<ol role="log">` but
  deliberately *not* a live region; a separate `role="status"` announces only the newest completed
  message, so each is spoken exactly once. A second `sr-only` live region reports tool
  confirmations and cart changes made by voice — without it, a voice-added item would be silent
  for anyone not opening the cart drawer.
- **Magnification uses CSS `zoom`, not `transform: scale`.** `zoom` re-runs layout, so there is no
  overlap, no clipping, no horizontal scrollbar, and hit targets stay valid — with a `font-size`
  fallback behind `@supports`.
- **Motion has a real kill-switch.** Both `@media (prefers-reduced-motion: reduce)` and an explicit
  `:root[data-reduced-motion="on"]` override exist, and every component independently combines the
  user preference with Framer's `useReducedMotion()`. Under reduced motion the core repaints
  exactly one static frame.
- **Minimum 44 px targets** (`--tap: 2.75rem`) and a 3 px `:focus-visible` outline.
- **`forced-colors` support** — borders, focus rings and the spotlight stay visible in Windows
  High Contrast.
- **A real skip link** to `#main`, and a `<canvas>` that is `aria-hidden` behind a real labelled
  `<button>`.
- **44 px is not the whole story** — the Agent Core is a primary `<button>`, not a div with a click
  handler, so it is keyboard-focusable and operable without a pointer.
- **The magnifier control never lies** — it is disabled and explained when `CSS.supports("zoom")`
  is false, rather than silently doing nothing.

---

## Known limitations

Being explicit about what this is not:

- **No authentication or authorization.** Sessions are anonymous UUIDs persisted in `localStorage`.
  Anyone with a session id can read and mutate that session's cart. `cors()` is fully open.
- **No rate limiting or request logging.** The `30mb` JSON body limit exists only for the demo
  audio path; in the live path audio never reaches this server.
- **No multi-item conversational memory beyond `recentProductIds` + `lastAction`.** The model
  itself has no memory between sessions; history lives in the AssemblyAI session.
- **Untested browser paths.** `EchoApp.tsx`, `AgentCore`'s rAF loop, `lib/api.ts`'s SSE splitting,
  `lib/voiceAgent.ts`'s WebSocket protocol, `lib/voiceAudio.ts`, `prefs.ts` and `session.ts` have
  no automated tests. The architectural answer is that their logic was pushed into pure functions —
  but it is not the same as coverage.
- **`backend/scripts/**` is outside `tsconfig.json`'s `include`**, so `e2e-gemini.ts` and
  `gemini-compat-stub.mjs` are neither typechecked nor tested.
- **`VOICE_AGENT_WS_URL` is configured but never read**; the WS host is hardcoded in the client.
- **`GEMINI_VISION_MODEL` is dead config** (see above).
- **`MemoryStore` loses everything on restart** — carts, orders and sessions included.
- **`src/scripts/voiceE2E.ts` and `verifyOrder.ts` have no npm scripts** and need real credentials.
- **Single store per process.** No cache, no read replicas, no pagination on `searchProducts`
  (it is capped at 4 results by design).
- **Frontend `tsx` is not declared** in `frontend/package.json` — it is hoisted from `backend`'s
  devDependencies. A frontend-only install would not have a test runner.

---

## Troubleshooting

**The page loads but every API call fails.**
The most common cause by far. The frontend alone is not enough — the backend must be listening on
the port `next.config.mjs` resolved. Start both with `npm run dev`, not `npm run dev:frontend`, and
check `curl http://localhost:4000/api/health`. If the backend is on a non-default port, set
`BACKEND_PORT` before starting Next (or change `PORT` in `backend/.env` and restart Next — the
value is read at build time, not per request).

**"Port(s) already in use — not starting a second copy"**
A backend or frontend is still running from a previous session. `scripts/dev.mjs` refuses to start
a second copy rather than crash confusingly. Stop the other process, or set `PORT` /
`FRONTEND_PORT`.

**`Could not find the module "..." in the React Client Manifest`**
A stale `.next` cache, common on WSL/Windows mounts. Run `npm run dev:frontend:clean`.
(`frontend/scripts/cleanNext.mjs` does the same thing and is currently not wired to a script.)

**`the backend did not answer (HTTP 5xx)`**
Next successfully reached the backend and the backend did not reply. Usually a boot crash — scroll
the backend log. A 5xx from a rewritten `/api/*` route is what `lib/api.ts` surfaces this as.

**`the site could not reach its own server`**
The request never left Next. The dev server itself is not up.

**`MONGOOSE_CONNECTION` / Mongo connect timeout at boot**
Expected with a bad URI or an IP outside the Atlas allowlist. The backend logs a loud warning and
falls back to `MemoryStore` on purpose. Set `REQUIRE_MONGO=true` in deployment to turn this into a
hard failure instead.

**Voice setup returns 503 `voice_not_configured`**
`ASSEMBLYAI_API_KEY` is unset. The app is in demo mode; use the composer.

**Voice setup returns 502 `token_mint_failed`**
The key is present but rejected. Check the key and its account scope.

**`POST /api/voice` returns 409 `use_voice_agent`**
Expected. The key is set, so the live Voice Agent path must be used and the legacy SSE pipeline is
deliberately disabled.

**`npm run demo` throws `LlmProviderError`**
The demo uses a real provider whenever a key is *present*, and a key that is rejected (no credits,
wrong scope) makes it fail rather than quietly fall back to the placeholder. To force the keyless
path, temporarily move `backend/.env` aside and rerun. Watch the `[LLM]` lines to see the real
cause — a `429` means out of credits, a `401`/`403` means a bad key or wrong scope.

**The assistant says it has no LLM**
No `OPENAI_API_KEY` and no `GEMINI_API_KEY` ⇒ `PlaceholderBrain`, which handles the core shopping
conversation by rules but is far less flexible. The backend logs a warning at boot.

**Everything works but answers are awkward**
Check `GET /api/capabilities` — `llmProvider` and `llmMode` tell you exactly which brain is live.

---

## License

Private project. No license granted.
