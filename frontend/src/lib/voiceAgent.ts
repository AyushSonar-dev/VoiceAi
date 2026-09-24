import type { ToolResult, VoiceAgentSetup } from "@/types";
import {
  int16ToBase64,
  startCapture,
  createPlayer,
  type VoiceMic,
  type VoicePlayer,
} from "@/lib/voiceAudio";

export type AgentStatus =
  | "connecting"
  | "listening"
  | "thinking"
  | "ended"
  | "error";

interface ToolInvocation {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceAgentEvents {
  onStatus?: (status: AgentStatus) => void;
  onUserTranscript?: (text: string, final: boolean) => void;
  onAgentTranscript?: (text: string, final: boolean, interrupted: boolean) => void;
  /** fired after a tool has been executed and its result is being sent back */
  onToolCall?: (info: { name: string; args: Record<string, unknown>; result: ToolResult }) => void;
  /** interrupted=true when the user barged in and cut the reply short */
  onReplyDone?: (opts: { interrupted: boolean; sentToolResult: boolean }) => void;
  onError?: (message: string) => void;
}

const WS_URL = "wss://agents.assemblyai.com/v1/ws";

/**
 * One side of the real conversation. The browser holds the WebSocket directly
 * (short-lived AssemblyAI token, no API key client-side); AssemblyAI owns STT,
 * LLM routing, TTS and turn-taking. `tool.call` events are relayed to the
 * Express gateway (/api/tools/:name) with our app sessionId injected, and the
 * result returns to the agent as `tool.result` — so the agent genuinely waits
 * for the backend before it is allowed to speak.
 */
export class VoiceAgentSession {
  private ws: WebSocket | null = null;
  private captured: { mic: VoiceMic } | null = null;
  private playerCtx: AudioContext | null = null;
  private player: VoicePlayer | null = null;
  private ready = false;
  private closed = false;
  private pendingTools: Map<string, ToolInvocation> = new Map();
  private connecting: Promise<void> | null = null;
  private status: AgentStatus | null = null;

  constructor(
    private setup: VoiceAgentSetup,
    private toolRunner: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
    private events: VoiceAgentEvents
  ) {}

  get isReady(): boolean {
    return this.ready && !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connect (idempotent) and resolve once session.ready has arrived. */
  connect(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.setStatus("connecting");
    const url = new URL(WS_URL);
    url.searchParams.set("token", this.setup.token);
    const socket = new WebSocket(url);

    this.connecting = new Promise<void>((resolve, reject) => {
      const onReady = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "session.ready") {
          this.ready = true;
          socket.removeEventListener("message", onReady);
          resolve();
        } else if (msg.type === "session.error") {
          socket.removeEventListener("message", onReady);
          reject(new Error(`${msg.code ?? "session_error"}: ${msg.message ?? "session failed"}`));
        }
      };
      const onOpen = () => {
        socket.send(JSON.stringify({ type: "session.update", session: this.setup.session }));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", (event) => {
        onReady(event);
        this.handleRaw(event.data);
      });
      socket.addEventListener("close", () => {
        if (!this.ready && this.connecting) {
          this.connecting = null;
          reject(new Error("connection closed before session.ready"));
        }
      });
      socket.addEventListener("error", () => {
        if (!this.ready) {
          this.connecting = null;
          reject(new Error("WebSocket error while connecting"));
        }
      });
      this.ws = socket;
    });
    return this.connecting;
  }

  /** Inject a user message and force a reply (typed input / quick-action buttons). */
  async input(text: string): Promise<void> {
    await this.connect();
    if (!this.isReady) throw new Error("voice session is not ready");
    this.setStatus("thinking");
    this.ws?.send(JSON.stringify({ type: "conversation.message", role: "user", content: text }));
    // Let the injected message land in context before forcing the reply —
    // sending both back-to-back lets the agent answer from stale context.
    await new Promise((r) => setTimeout(r, 400));
    this.ws?.send(
      JSON.stringify({
        type: "reply.create",
        instructions:
          "Respond to the user's latest message. If they are describing what to shop for or an action to take, call the matching tool immediately — do not chat before calling.",
      })
    );
  }

  /** Start streaming the microphone into the agent (voice path). */
  async startMic(): Promise<void> {
    await this.connect();
    if (!this.isReady) throw new Error("voice session is not ready");
    if (this.captured) return;
    const mic = await startCapture();
    this.captured = { mic };
    mic.setOnPcm((b64) => {
      if (this.isReady) this.ws?.send(JSON.stringify({ type: "input.audio", audio: b64 }));
    });
  }

  /** Stop the microphone but keep the session open for typed input. */
  stopMic(): void {
    this.captured?.mic.stop();
    this.captured = null;
  }

  /** End the call cleanly: session.end -> session.ended -> close. */
  end(): void {
    this.closed = true;
    this.ready = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "session.end" }));
      this.ws.close();
    }
    this.teardownAudio();
    this.setStatus("ended");
  }

  private ensurePlayer(): VoicePlayer {
    if (!this.player) {
      const ctx = new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
      this.playerCtx = ctx;
      this.player = createPlayer(ctx);
    }
    return this.player;
  }

  private teardownAudio(): void {
    this.captured?.mic.stop();
    this.captured = null;
    if (this.playerCtx) {
      void this.playerCtx.close().catch(() => undefined);
      this.playerCtx = null;
      this.player = null;
    }
  }

  private handleRaw(raw: unknown): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg.type) {
      case "session.ready":
        this.setStatus("listening");
        break;
      case "input.speech.started":
        this.pendingTools.clear();
        this.setStatus("listening");
        break;
      case "transcript.user.delta":
        this.events.onUserTranscript?.(String(msg.text), false);
        break;
      case "transcript.user":
        this.setStatus("thinking");
        this.events.onUserTranscript?.(String(msg.text), true);
        break;
      case "reply.started":
        this.player?.flush();
        this.setStatus("thinking");
        break;
      case "reply.audio":
        this.ensurePlayer().play(String(msg.data));
        break;
      case "transcript.agent.delta":
        this.events.onAgentTranscript?.(String(msg.delta), false, false);
        break;
      case "transcript.agent":
        this.events.onAgentTranscript?.(String(msg.text), true, Boolean(msg.interrupted));
        break;
      case "tool.call": {
        const inv: ToolInvocation = {
          call_id: String(msg.call_id),
          name: String(msg.name),
          args: (typeof msg.arguments === "object" && msg.arguments) || {},
        };
        this.pendingTools.set(inv.call_id, inv);
        break;
      }
      case "reply.done": {
        const interrupted = msg.status !== "completed";
        if (!interrupted && this.pendingTools.size > 0) {
          this.setStatus("thinking");
          this.events.onReplyDone?.({ interrupted: false, sentToolResult: false });
          void this.executePendingTools();
        } else {
          this.pendingTools.clear();
          this.player?.flush();
          this.setStatus("listening");
          this.events.onReplyDone?.({ interrupted, sentToolResult: false });
        }
        break;
      }
      case "session.error":
        this.events.onError?.(`${msg.code ?? "session_error"}: ${msg.message ?? "session error"}`);
        this.setStatus("error");
        break;
      case "session.ended":
        this.teardownAudio();
        this.setStatus("ended");
        break;
      default:
        break;
    }
  }

  private async executePendingTools(): Promise<void> {
    const invocations = [...this.pendingTools.values()];
    this.pendingTools.clear();
    for (const inv of invocations) {
      try {
        const result = await this.toolRunner(inv.name, inv.args);
        this.events.onToolCall?.({ name: inv.name, args: inv.args, result });
        const frame = {
          type: "tool.result",
          call_id: inv.call_id,
          result: JSON.stringify(result),
          is_error: !result.success,
        };
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
      } catch (err) {
        this.events.onError?.(err instanceof Error ? err.message : "tool execution failed");
        const frame = {
          type: "tool.result",
          call_id: inv.call_id,
          result: JSON.stringify({ success: false, error: "relay_error", message: "Tool execution failed.", data: {} }),
          is_error: true,
        };
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
      }
    }
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus?.(status);
  }
}

export type { ToolResult };