import { getStore } from "../db/index.js";
import { selfOrigin } from "../config.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../tools/index.js";
import { buildSystemPrompt, LOOP_EXHAUSTED_REPLY, MAX_LOOP_TURNS } from "./prompts.js";
import { createLlm } from "./llm/index.js";
import type { Llm, ChatMessage, ToolCallRequest } from "./llm/types.js";
import type { ToolResult } from "../types.js";

export type DispatchFn = (name: string, params: Record<string, any>) => Promise<ToolResult>;

export interface TurnOptions {
  sessionId: string;
  userText: string;
  llm?: Llm;
  /** Defaults to the HTTP tool gateway (POST /api/tools/:name). Inject for tests. */
  dispatch?: DispatchFn;
  gatewayUrl?: string;
  onToolCall?: (info: { name: string; index: number; args: Record<string, any> }) => void;
}

export interface ToolInvocation {
  name: string;
  args: Record<string, any>;
  result: ToolResult;
}

export interface TurnResult {
  reply: string;
  turns: number;
  toolCalls: ToolInvocation[];
  exhausted?: boolean;
}

/**
 * THE REAL TOOL-USE LOOP.
 *
 * 1. The LLM sees the user's message + this turn's allowed product ids.
 * 2. If it needs an action, it emits a tool call; the loop hands the call to the
 *    backend tool gateway (over HTTP by default) and waits.
 * 3. The backend result — success or failure — is appended as a tool message.
 * 4. Only after that result does the model generate its spoken reply.
 *
 * The loop is structurally incapable of letting the model claim an action
 * happened before the backend confirms it: there is no code path that returns a
 * spoken reply while a tool call is still in flight, and a non-success tool
 * result is presented to the model as-is.
 */
export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const store = getStore();
  const session = await store.getOrCreateSession(options.sessionId);
  const llm = options.llm ?? createLlm();
  const dispatch = options.dispatch ?? httpToolGateway(options.gatewayUrl ?? selfOrigin);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(session) },
    { role: "user", content: options.userText },
  ];

  const toolCalls: ToolInvocation[] = [];
  const tools: ToolDefinition[] = TOOL_DEFINITIONS;

  for (let turn = 0; turn < MAX_LOOP_TURNS; turn++) {
    const resp = await llm.chat({ messages, tools });
    const msg = resp.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || LOOP_EXHAUSTED_REPLY, turns: turn + 1, toolCalls };
    }

    for (const tc of msg.tool_calls) {
      const parsed = await parseArguments(tc);
      const args = { sessionId: options.sessionId, ...parsed };
      options.onToolCall?.({ name: tc.function.name, index: toolCalls.length, args });
      const result = await dispatch(tc.function.name, args);
      toolCalls.push({ name: tc.function.name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Safety net after N tool turns: never claim anything here.
  return { reply: LOOP_EXHAUSTED_REPLY, turns: MAX_LOOP_TURNS, toolCalls, exhausted: true };
}

/** The LLM reaches the backend through the Express tool gateway over HTTP —
 * the same endpoint the UI/tests hit, so the "gateway" is the single door. */
export function httpToolGateway(origin: string) {
  return async (name: string, params: Record<string, any>): Promise<ToolResult> => {
    const res = await fetch(`${origin}/api/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params ?? {}),
    });
    if (!res.ok) {
      return {
        success: false,
        error: "gateway_error",
        message: `The backend could not be reached (HTTP ${res.status}). Nothing was changed.`,
        data: {},
      };
    }
    return (await res.json()) as ToolResult;
  };
}

async function parseArguments(tc: ToolCallRequest): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(tc.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}