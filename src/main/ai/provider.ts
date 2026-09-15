/**
 * Provider abstraction (spec §1, §4). The orchestrator only ever talks to this interface.
 * Swapping Gemini for another vendor means adding one file and changing config — never a rewrite.
 */

export interface ToolDefinition {
  name: string
  description: string
  /** Plain JSON Schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Opaque provider data that must be echoed back with the call (Gemini "thought signatures"). */
  signature?: string
}

export interface ToolResult {
  callId: string
  name: string
  /** JSON-serialisable result or error payload. */
  result: Record<string, unknown>
}

export type ProviderMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string | null; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] }

export interface CompletionRequest {
  system: string
  messages: ProviderMessage[]
  tools: ToolDefinition[]
  /** Groups the rounds of one user message so a provider can keep them on one model. */
  turnId?: string
}

export interface CompletionResponse {
  text: string | null
  toolCalls: ToolCall[]
  usage?: { input?: number; output?: number }
  /** Which concrete model answered (for the log). */
  model?: string
}

export interface Provider {
  readonly name: string
  readonly model: string
  complete(req: CompletionRequest, onThrottle?: (retryInSeconds: number) => void): Promise<CompletionResponse>
}

/** Thrown when the provider cannot be used at all (e.g. no API key). */
export class ProviderUnavailableError extends Error {}
