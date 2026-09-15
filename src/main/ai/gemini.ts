import { FunctionCallingConfigMode, GoogleGenAI, type Content, type Part } from '@google/genai'
import { log } from '../log'
import type { CompletionRequest, CompletionResponse, Provider, ToolCall } from './provider'

const BACKOFF_MS = [1000, 2000, 4000, 8000]

function isThrottle(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string }
  const msg = (e?.message ?? '').toUpperCase()
  return e?.status === 429 || e?.code === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')
}

/** Gemini does not always return call ids; ones we invented locally must not be echoed back. */
const realId = (id: string): { id?: string } => (id.startsWith('local_') ? {} : { id })

function toContents(req: CompletionRequest): Content[] {
  const out: Content[] = []
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.text }] })
    } else if (m.role === 'assistant') {
      const parts: Part[] = []
      if (m.text) parts.push({ text: m.text })
      for (const c of m.toolCalls)
        parts.push({
          functionCall: { ...realId(c.id), name: c.name, args: c.args },
          ...(c.signature ? { thoughtSignature: c.signature } : {})
        })
      if (parts.length) out.push({ role: 'model', parts })
    } else {
      out.push({
        role: 'user',
        parts: m.results.map((r) => ({ functionResponse: { ...realId(r.callId), name: r.name, response: r.result } }))
      })
    }
  }
  return out
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini'
  private ai: GoogleGenAI
  constructor(
    apiKey: string,
    readonly model: string
  ) {
    this.ai = new GoogleGenAI({ apiKey })
  }

  async complete(req: CompletionRequest, onThrottle?: (s: number) => void): Promise<CompletionResponse> {
    let attempt = 0
    for (;;) {
      try {
        const res = await this.ai.models.generateContent({
          model: this.model,
          contents: toContents(req),
          config: {
            systemInstruction: req.system,
            temperature: 0.2,
            tools: req.tools.length
              ? [
                  {
                    functionDeclarations: req.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.parameters
                    }))
                  }
                ]
              : undefined,
            toolConfig: req.tools.length ? { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } } : undefined
          }
        })
        const parts = res.candidates?.[0]?.content?.parts ?? []
        const toolCalls: ToolCall[] = []
        const texts: string[] = []
        let i = 0
        for (const p of parts) {
          if (p.functionCall?.name) {
            toolCalls.push({
              id: p.functionCall.id ?? `local_${Date.now()}_${i++}`,
              name: p.functionCall.name,
              args: (p.functionCall.args ?? {}) as Record<string, unknown>,
              signature: p.thoughtSignature
            })
          } else if (p.text && !p.thought) {
            texts.push(p.text)
          }
        }
        const u = res.usageMetadata
        return {
          text: texts.length ? texts.join('') : null,
          toolCalls,
          usage: { input: u?.promptTokenCount, output: u?.candidatesTokenCount }
        }
      } catch (err) {
        if (isThrottle(err) && attempt < BACKOFF_MS.length) {
          const wait = BACKOFF_MS[attempt++]
          log('warn', 'ai.throttled', `429 from ${this.model}; retrying in ${wait / 1000}s (attempt ${attempt})`)
          onThrottle?.(wait / 1000)
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
        throw err
      }
    }
  }
}
