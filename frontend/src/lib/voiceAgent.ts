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

/**
 * How a partial transcript must be combined with what is already on screen.
 * AssemblyAI's two streaming events differ: `transcript.user.delta` resends the
 * whole utterance so far (cumulative), while `transcript.agent.delta` sends only
 * the newly spoken words (incremental). Exposing that distinction in the type
 * makes it impossible for a caller to render "H He Hel Hello" by accident.
 */
export type TranscriptPart = "cumulative" | "incremental";

export interface VoiceAgentEvents {
  onStatus?: (status: AgentStatus) => void;
  /** `mode` says how to combine `text` with the previous partial. */
  onUserTranscript?: (text: string, final: boolean, mode: TranscriptPart) => void;
  onAgentTranscript?: (
    text: string,
    final: boolean,
    interrupted: boolean,
    mode: TranscriptPart
  ) => void;
  /** fired when the server starts a fresh user turn, so partials can be sealed */
  onUserTurnStart?: () => void;
  /** fired after a tool has been executed and its result is being sent back */
  onToolCall?: (info: { name: string; args: Record<string, unknown>; result: ToolResult }) => void;
  /** interrupted=true when the user barged in and cut the reply short */
  onReplyDone?: (opts: { interrupted: boolean; sentToolResult: boolean }) => void;
  onError?: (message: string) => void;
  /**
   * Measured audio level 0..1, tagged with where it came from. "in" is the
   * user's microphone, "out" is the agent's own voice. Both are real RMS
   * readings — the interface must never invent a level when audio is silent.
   */
  onAudioLevel?: (level: number, source: "in" | "out") => void;
  /** true while the agent's voice is actually being produced/played */
  onSpeakingChange?: (speaking: boolean) => void;
}

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
  private speaking = false;
  private bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUserSpeechAt = 0;

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
    const url = new URL(this.setup.wsUrl);
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
    // Fire reply.create immediately after the message frame — AssemblyAI's
    // voice agent processes frames in order, so the reply will follow the
    // injected message without an artificial sleep. The previous 400 ms wait
    // was pure wasted time on every single typed/button turn.
    this.ws?.send(
      JSON.stringify({
        type: "reply.create",
        instructions:
          "Respond to the user's latest message like a person on a call. If it's something to shop for or an action to take, give a tiny acknowledgement like 'sure, one sec' and call the matching tool right away.",
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
    mic.setOnLevel((level) => {
      if (!this.closed) this.events.onAudioLevel?.(level, "in");
    });
  }

  /** Stop the microphone but keep the session open for typed input. */
  stopMic(): void {
    this.captured?.mic.stop();
    this.captured = null;
    this.events.onAudioLevel?.(0, "in");
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
      this.player = createPlayer(ctx, {
        onLevel: (level) => {
          if (!this.closed) this.events.onAudioLevel?.(level, "out");
        },
      });
    }
    return this.player;
  }

  private teardownAudio(): void {
    this.clearBargeInTimer();
    this.captured?.mic.stop();
    this.captured = null;
    if (this.playerCtx) {
      void this.playerCtx.close().catch(() => undefined);
      this.playerCtx = null;
      this.player = null;
    }
    this.events.onAudioLevel?.(0, "in");
    this.events.onAudioLevel?.(0, "out");
    this.setSpeaking(false);
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.events.onSpeakingChange?.(speaking);
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
        this.pauseForBargeIn();
        // A new turn begins, so any still-streaming bubble is now final.
        this.events.onUserTurnStart?.();
        this.setStatus("listening");
        break;
      case "transcript.user.delta":
        this.lastUserSpeechAt = Date.now();
        // First transcription delta = user is definitely speaking. If the audio
        // context is still running at this point (input.speech.started may not
        // have fired yet, or fired while the context was in a transitional state),
        // force-suspend immediately. This gives sub-100ms pause latency.
        if (this.playerCtx?.state === "running") this.pauseForBargeIn();
        // Cumulative: each event is the whole utterance so far, so it replaces
        // the previous partial rather than adding to it.
        this.events.onUserTranscript?.(String(msg.text ?? msg.delta ?? ""), false, "cumulative");
        break;
      case "transcript.user":
        // A real user turn: whatever the agent was mid-way through is stale.
        this.dropPausedAudio();
        this.setStatus("thinking");
        this.events.onUserTranscript?.(String(msg.text), true, "cumulative");
        break;
      case "reply.started":
        this.dropPausedAudio();
        this.setStatus("thinking");
        break;
      case "reply.audio":
        this.ensurePlayer().play(String(msg.data));
        if (this.playerCtx?.state !== "suspended") this.setSpeaking(true);
        break;
      case "transcript.agent.delta":
        // Incremental: only the words just spoken, so they append.
        this.events.onAgentTranscript?.(
          String(msg.delta ?? msg.text ?? ""),
          false,
          false,
          "incremental"
        );
        break;
      case "transcript.agent":
        this.setSpeaking(true);
        this.events.onAgentTranscript?.(String(msg.text), true, Boolean(msg.interrupted), "cumulative");
        break;
      case "tool.call": {
        const inv: ToolInvocation = {
          call_id: String(msg.call_id),
          name: String(msg.name),
          args: (typeof msg.arguments === "object" && msg.arguments) || {},
        };
        // Execute immediately — don't wait for reply.done. This way the tool
        // runs concurrently with any filler audio the agent is still playing,
        // and the result is ready the moment the agent needs it.
        void this.executeToolNow(inv);
        break;
      }
      case "reply.done": {
        const interrupted = msg.status !== "completed";
        this.setSpeaking(false);
        this.pendingTools.clear();
        // Only flush on interruption. reply.done fires when all audio chunks
        // have been *sent*, not when they have finished *playing* — flushing on
        // a normal completion would stop the last buffered frames mid-sentence.
        // A paused-but-not-interrupted reply is resumed by the backchannel timer.
        if (interrupted) this.dropPausedAudio();
        this.setStatus("listening");
        this.events.onReplyDone?.({ interrupted, sentToolResult: false });
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

  /**
   * The instant the user makes a sound, the agent goes quiet — suspending the
   * output context freezes playback with no delay. Suspending (not flushing)
   * matters because AssemblyAI's barge-in is semantic: an "mm-hmm" isn't an
   * interruption, and the agent should carry on mid-word rather than lose it.
   */
  private pauseForBargeIn(): void {
    const ctx = this.playerCtx;
    if (!ctx || ctx.state !== "running") return;
    void ctx.suspend();
    this.setSpeaking(false);
    this.lastUserSpeechAt = Date.now();
    this.scheduleBackchannelResume();
  }

  // No interruption confirmed and the user has gone quiet → it was a
  // backchannel ("mm-hmm"), so carry on. Never resume over live speech.
  private scheduleBackchannelResume(): void {
    this.clearBargeInTimer();
    this.bargeInTimer = setTimeout(() => {
      if (Date.now() - this.lastUserSpeechAt < 400) this.scheduleBackchannelResume();
      else this.resumeAfterBackchannel();
    }, 500);
  }

  private resumeAfterBackchannel(): void {
    this.clearBargeInTimer();
    const ctx = this.playerCtx;
    if (ctx && ctx.state === "suspended") void ctx.resume();
  }

  private dropPausedAudio(): void {
    this.clearBargeInTimer();
    this.player?.flush();
    this.setSpeaking(false);
    const ctx = this.playerCtx;
    if (ctx && ctx.state === "suspended") void ctx.resume();
  }

  private clearBargeInTimer(): void {
    if (this.bargeInTimer !== null) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = null;
  }

  private async executeToolNow(inv: ToolInvocation): Promise<void> {
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

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus?.(status);
  }
}

export type { ToolResult };