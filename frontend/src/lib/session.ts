/**
 * Session management for the frontend.
 *
 * With the new authentication system, sessions are managed via HTTP-only cookies
 * set by the backend. The frontend just needs to send credentials with requests.
 * We keep a minimal localStorage fallback for backward compatibility with demo/tests.
 */

const KEY = "echolabs.sessionId";

export function loadSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function saveSessionId(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, id);
}

export function clearSessionId(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

export async function ensureSessionId(create: () => Promise<string>): Promise<string> {
  // First try to use the cookie-based session (backend will return existing or create new)
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sessionId) {
        saveSessionId(data.sessionId); // Keep localStorage in sync for backward compat
        return data.sessionId;
      }
    }
  } catch {
    // Fall through to localStorage fallback
  }

  // Fallback: use localStorage (for demo/tests without backend auth)
  const existing = loadSessionId();
  if (existing) return existing;
  const id = await create();
  saveSessionId(id);
  return id;
}