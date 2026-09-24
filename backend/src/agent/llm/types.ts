import type { ToolDefinition } from "../../tools/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCallRequest[] | null;
  tool_call_id?: string;
}

export interface ToolCallRequest {
  id: string;
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: ToolCallRequest[] | null;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

export interface ChatResponse {
  message: AssistantMessage;
}

/**
 * The LLM service contract — anything that implements this can drive the
 * tool-use loop (an OpenAI-compatible model or the placeholder brain).
 */
export interface Llm {
  chat(req: ChatRequest): Promise<ChatResponse>;
}