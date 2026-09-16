import { FunctionCallingConfigMode, GoogleGenAI, type Content, type Part } from '@google/genai'
import { log } from '../log'
import type { CompletionRequest, CompletionResponse, Provider, ToolCall } from './provider'

const BACKOFF_MS = [1000, 2000, 4000, 8000]
const MAX_WAIT_MS = 65_000
const MAX_ATTEMPTS = 6

interface ApiErr {
  status?: number
  code?: number
  message?: string
}

function statusOf(err: unknown): number {
  const e = err as ApiErr
  if (typeof e?.status === 'number') return e.status
  if (typeof e?.code === 'number') return e.code
  const m = /"code":\s*(\d{3})/.exec(e?.message ?? '')
  return m ? Number(m[1]) : 0
}

/** 429 = quota; 503 = "high demand". Both are temporary and worth waiting out. */
const isRetryable = (err: unknown): boolean => {
  const s = statusOf(err)
  const msg = ((err as ApiErr)?.message ?? '').toUpperCase()
  return s === 429 || s === 503 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('UNAVAILABLE')
}

/** Google says how long to wait ("Please retry in 43.8s" / retryDelay "43s"); use it when present. */
function suggestedWaitMs(err: unknown): number | null {
  const msg = (err as ApiErr)?.message ?? ''
  const a = /retry in ([\d.]+)s/i.exec(msg)
  if (a) return Math.ceil(Number(a[1]) * 1000)
  const b = /"retryDelay":\s*"([\d.]+)s"/.exec(msg)
  if (b) return Math.ceil(Number(b[1]) * 1000)
  return null
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

/**
 * Gemini provider. Takes an ordered list of models; free-tier quotas are per model, so when the first
 * is exhausted at the start of a turn we move to the next. Once a turn has begun on a model it stays
 * there (thought signatures are model-specific), and further throttling is waited out.
 */
export class GeminiProvider implements Provider {
  readonly name = 'gemini'
  private ai: GoogleGenAI
  private readonly models: string[]
  private turnModel = new Map<string, string>()

  constructor(apiKey: string, models: string[]) {
    this.ai = new GoogleGenAI({ apiKey })
    this.models = models.length ? models : ['gemini-3.6-flash']
  }

  get model(): string {
    return this.models.join(' → ')
  }

  async complete(req: CompletionRequest, onThrottle?: (s: number) => void): Promise<CompletionResponse> {
    const turn = req.turnId ?? `t${Date.now()}`
    let modelIdx = Math.max(0, this.models.indexOf(this.turnModel.get(turn) ?? ''))
    const pinned = this.turnModel.has(turn)
    if (!pinned && req.preferStrong && this.models.length > 1 && modelIdx === 0) modelIdx = 1
    let attempt = 0
    for (;;) {
      const model = this.models[modelIdx]
      try {
        const res = await this.callModel(model, req)
        if (!pinned) {
          this.turnModel.set(turn, model)
          if (this.turnModel.size > 20) this.turnModel.delete(this.turnModel.keys().next().value!)
        }
        return res
      } catch (err) {
        if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err
        // Not yet committed to a model this turn and another is available: switch instead of waiting.
        if (!this.turnModel.has(turn) && modelIdx < this.models.length - 1) {
          log('warn', 'ai.model_switch', `${model} throttled (${statusOf(err)}); trying ${this.models[modelIdx + 1]}`)
          modelIdx++
          continue
        }
        // Google's retryDelay is authoritative; the fixed 1/2/4/8 s ladder is only the fallback when it is absent.
        const hinted = suggestedWaitMs(err)
        const wait = Math.min(MAX_WAIT_MS, (hinted ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]) + 250)
        attempt++
        log(
          'warn',
          'ai.throttled',
          `${statusOf(err)} from ${model}; retrying in ${Math.round(wait / 1000)}s (${hinted ? 'server retryDelay' : 'fallback backoff'}, attempt ${attempt})`
        )
        onThrottle?.(Math.round(wait / 1000))
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }

  private async callModel(model: string, req: CompletionRequest): Promise<CompletionResponse> {
    const res = await this.ai.models.generateContent({
      model,
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
      usage: { input: u?.promptTokenCount, output: u?.candidatesTokenCount },
      model
    }
  }
}
