import type { Capabilities, EchoState, SseEvent, TurnEvents } from "@/types";

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`request to ${url} failed with ${res.status}`);
  return res.json() as Promise<T>;
}

export async function newSession(): Promise<string> {
  const data = await readJson<{ sessionId: string }>("/api/session", { method: "POST" });
  return data.sessionId;
}

export async function getCapabilities(): Promise<Capabilities> {
  return readJson<Capabilities>("/api/capabilities");
}

export async function getState(sessionId: string): Promise<EchoState> {
  return readJson<EchoState>(`/api/state/${encodeURIComponent(sessionId)}`);
}

/**
 * POST /api/voice streams server-sent events; this reads the stream incrementally
 * so the UI can announce the "let me check that" filler while the tools run.
 */
export async function postTurn(input: {
  sessionId: string;
  text?: string;
  audioBase64?: string;
}): Promise<TurnEvents> {
  const res = await fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
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