# EchoMart — High-Level Design (HLD)

> AssemblyAI Voice Agent Hackathon · lablab.ai · September 2026

---

## 1. System Overview

EchoMart is a **voice-first e-commerce assistant** designed for users with visual
impairments or anyone who prefers hands-free shopping. A single natural-language
conversation replaces the entire browse → search → add-to-cart → checkout flow.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               USER (Browser)                                │
│                                                                             │
│  ┌─────────────┐    PCM16 audio    ┌──────────────────────────────────────┐ │
│  │  Microphone │ ────────────────► │   AssemblyAI Voice Agent WebSocket   │ │
│  │  (getUserM) │                   │   wss://agents.assemblyai.com/v1/ws  │ │
│  └─────────────┘                   │                                      │ │
│                                    │  ┌────────┐  ┌─────┐  ┌───────────┐ │ │
│  ┌─────────────┐   PCM16 audio     │  │  STT   │  │ LLM │  │    TTS    │ │ │
│  │   Speaker   │ ◄──────────────── │  │(Univ-1)│  │     │  │(ivy voice)│ │ │
│  └─────────────┘                   │  └────────┘  └──┬──┘  └───────────┘ │ │
│                                    │               tool.call              │ │
│  ┌──────────────────────────────┐  └───────────────┼──────────────────────┘ │
│  │      Next.js Frontend        │                  │  HTTPS tool relay      │
│  │   EchoApp + VoiceAgent.ts    │ ◄────────────────┘                        │
│  └──────────────────────────────┘                                           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │  POST /api/tools/:name
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Express Backend (Node/TS)                           │
│                                                                              │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Tool Router │  │  Session Mgr  │  │   LLM Brain  │  │ Voice Setup   │  │
│  │ /api/tools/* │  │  (sessionId)  │  │  (GPT/Gemini)│  │  Token Mint   │  │
│  └──────┬───────┘  └───────┬───────┘  └──────────────┘  └───────────────┘  │
│         │                  │                                                  │
│  ┌──────▼──────────────────▼──────────────────────────────────────────────┐  │
│  │                    In-Memory / MongoDB Store                            │  │
│  │   Sessions · Products (+ search cache) · Cart · Orders · Coupons      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key Components

| Component | Responsibility | Technology |
|---|---|---|
| **VoiceAgentSession** | Browser WebSocket client; routes audio, transcripts, tool calls | TypeScript class |
| **AssemblyAI Voice Agent** | STT + LLM routing + TTS + VAD + turn detection | AssemblyAI cloud |
| **Tool Gateway** | Validates + executes tool calls on behalf of the agent | Express.js routes |
| **Agent Brain** | LLM loop for demo/text mode | Gemini |
| **Store** | Product catalog + cart + orders + sessions | MongoDB Atlas (memory fallback) |
| **Search Cache** | In-process TTL cache (Map) for repeated search queries | Node.js Map |

---

## 3. Voice Latency Budget

The full voice path budget for a single turn:

```
User speaks → VAD silence 400 ms → STT finalization ~100 ms
→ LLM token-1 latency ~300 ms → TTS first chunk ~80 ms
→ PCM audio to browser → Agent speaks

Approximate end-to-end: 880 ms – 1 400 ms
(AssemblyAI handles the inner loop entirely on their infra)
```

**Latency optimisations applied:**
- `min_silence`: 700 ms → **400 ms** (saves 300 ms per turn)
- `interruption_delay`: 120 ms → **80 ms** (faster barge-in)
- Removed 400 ms artificial delay before `reply.create`
- Tool calls execute in parallel (`Promise.all`)
- Search results cached for 60 s (saves ~50–200 ms DB roundtrip)

---

## 4. Interruption Flow

```
Agent speaking (PCM streaming)
    │
    ├── User starts talking  ──► input.speech.started event
    │                               ├─ player.flush()       ← agent audio STOPS
    │                               ├─ setSpeaking(false)
    │                               └─ pendingTools.clear()
    │
    └── reply.done (status ≠ "completed") ──► interrupted path
            ├─ player.flush()
            └─ setStatus("listening")
```

The agent is interrupted in **two layers**:
1. AssemblyAI cloud (`interrupt_response: true`) stops generating tokens
2. Browser (`player.flush()`) drains the local audio queue immediately

---

## 5. Tool Call Round-Trip

```
AssemblyAI ──► tool.call  ──► Browser VoiceAgentSession
                                    │
                                    ├── POST /api/tools/searchProducts  ─► Store (+ cache)
                                    ├── POST /api/tools/addToCart        ─► Cart
                                    └── POST /api/tools/checkout         ─► Order

                               (all run in parallel via Promise.all)
                                    │
                               tool.result ──► AssemblyAI ──► TTS reply
```

---

## 6. Scalability Considerations

| Concern | Current (MVP) | Production Path |
|---|---|---|
| **Session state** | In-memory Map | Redis cluster |
| **Product search** | In-process TTL Map | Dedicated search service (Elasticsearch / Typesense) |
| **Database** | MongoDB Atlas M0 free | Atlas M10+ with replica set, read replicas in each region |
| **CDN** | None | Vercel Edge Network for Next.js, CloudFront for static assets |
| **Load balancing** | Single Node process | Horizontal scaling behind a load balancer; stateless workers + Redis for session |
| **Caching** | In-process (single node) | Redis for shared product + session cache across all workers |
| **Rate limiting** | None | Express-rate-limit per IP + per AssemblyAI token |
| **1M request capacity** | Not supported | ~20 Node workers + Redis + MongoDB Atlas M30 can handle ~50K concurrent voice sessions |

---

## 7. Security Notes

- AssemblyAI token is **short-lived** (5 min TTL, 15 min max session) — no API key ever leaves the backend
- Tool calls are validated server-side before execution — the agent cannot call arbitrary endpoints
- Sessions are scoped by a server-issued `sessionId` UUID — no user can access another user's cart
- CORS is open (MVP) → restrict to deployment origin in production
