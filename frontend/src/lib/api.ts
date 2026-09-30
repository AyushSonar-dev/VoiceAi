import type { Capabilities, EchoState, RecentProduct, SseEvent, ToolResult, TurnEvents, VoiceAgentSetup } from "@/types";

const DEFAULT_FETCH_OPTS: RequestInit = {
  credentials: "include",
};

/**
 * Internal helper for testing - not part of public API.
 */
export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...DEFAULT_FETCH_OPTS, ...init });
  } catch {
    // The request never left Next: usually the dev server itself is not up.
    throw new Error(`the site could not reach its own server (${url})`);
  }
  if (!res.ok) {
    // 5xx from a rewritten /api/* route means Next tried the backend and the
    // backend did not answer — the single most common "it won't connect" cause.
    throw new Error(
      res.status >= 500
        ? `the backend did not answer (HTTP ${res.status}) — is it running on the configured port?`
        : `request to ${url} failed with ${res.status}`
    );
  }
  return res.json() as Promise<T>;
}

export async function newSession(): Promise<string> {
  const data = await readJson<{ sessionId: string }>("/api/session", { method: "POST" });
  return data.sessionId;
}

export async function getCapabilities(): Promise<Capabilities> {
  return readJson<Capabilities>("/api/capabilities");
}

export async function getAllProducts(): Promise<RecentProduct[]> {
  const data = await readJson<{ products: RecentProduct[] }>("/api/products");
  return data.products;
}

export async function getState(): Promise<EchoState> {
  // No sessionId needed - comes from auth cookie
  return readJson<EchoState>("/api/state");
}

/**
 * Mint a short-lived Voice Agent token + inline agent config from our backend.
 * The real voice path connects straight from the browser to AssemblyAI using
 * this token; the raw API key never leaves the server.
 */
export async function getVoiceSetup(): Promise<VoiceAgentSetup> {
  return readJson<VoiceAgentSetup>("/api/voice/setup", { method: "POST" });
}

/**
 * Execute one tool call on the Express tool gateway. This is what the Voice
 * Agent's `tool.call` events are relayed to — validation, session scoping and
 * Mongo mutations all happen server-side, right here.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  return readJson<ToolResult>(`/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args), // sessionId comes from auth cookie
  });
}

/**
 * POST /api/voice streams server-sent events; this reads the stream incrementally
 * so the UI can announce the "let me check that" filler while the tools run.
 */
export async function postTurn(input: {
  text?: string;
  audioBase64?: string;
}): Promise<TurnEvents> {
  const res = await fetch("/api/voice", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input), // sessionId comes from auth cookie
  });
  if (!res.ok || !res.body) throw new Error(`voice request failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const push = (event: SseEvent): void => {
    if (event.type === "turn") events.userText = event.payload.userText;
    else if (event.type === "filler") events.filler = event.payload;
    else if (event.type === "final") {
      events.reply = event.payload.reply;
      events.audioUrl = event.payload.audioUrl;
      events.state = event.payload.state;
    } else if (event.type === "error") events.error = event.payload.message;
  };

  const events: TurnEvents = {
    userText: "",
    filler: null,
    reply: "",
    audioUrl: null,
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          push(JSON.parse(dataLine.slice(6)) as SseEvent);
        } catch {
          // ignore malformed frames
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }

  if (events.error) throw new Error(events.error);
  if (!events.reply) throw new Error("assistant returned no reply");
  return events;
}