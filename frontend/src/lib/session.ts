const KEY = "echolabs.sessionId";

export function loadSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function saveSessionId(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, id);
}

export async function ensureSessionId(create: () => Promise<string>): Promise<string> {
  const existing = loadSessionId();
  if (existing) return existing;
  const id = await create();
  saveSessionId(id);
  return id;
}