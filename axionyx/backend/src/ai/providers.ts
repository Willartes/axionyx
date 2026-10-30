import type { Provider } from './config'

/**
 * Adaptadores dos provedores (Anthropic Messages, OpenAI Chat Completions, Google Gemini generateContent) com a mesma
 * interface: o modelo pode pedir ferramentas (consultas ao AXIONYX) até chegar à resposta final.
 * Endereços substituíveis por variável (AI_ANTHROPIC_BASE_URL etc.) para proxy corporativo e testes.
 */
export interface ToolDef { name: string; description: string; parameters: { type: 'object'; properties: Record<string, any>; required?: string[] } }
export interface Turn { role: 'user' | 'assistant'; text: string }
export interface LoopInput {
  provider: Provider; key: string; model: string; system: string; history: Turn[]; tools: ToolDef[]
  exec: (name: string, args: any) => Promise<unknown>; maxSteps?: number; maxTokens?: number; timeoutMs?: number
}
export interface LoopOutput { text: string; inputTokens: number; outputTokens: number; calls: { name: string; args: any }[]; steps: number }

/** Nunca devolver pedaços de chave que o provedor eventualmente repita na mensagem de erro. */
const redact = (m: string) => m.replace(/\b(sk-[\w-]{4,}|AIza[\w-]{6,}|[A-Za-z0-9_-]{32,})/g, '[chave ocultada]')
export class AiError extends Error { constructor(message: string, public code: string, public status?: number) { super(redact(message)) } }

const base = (p: Provider) => ({
  anthropic: process.env.AI_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  openai: process.env.AI_OPENAI_BASE_URL || 'https://api.openai.com',
  gemini: process.env.AI_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
}[p].replace(/\/+$/, ''))

async function http(p: Provider, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }, timeoutMs = 90_000): Promise<any> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { method: init.method || 'POST', headers: { 'content-type': 'application/json', ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctl.signal })
  } catch (e: any) {
    throw new AiError(e?.name === 'AbortError' ? 'O provedor de IA demorou demais para responder.' : 'Não foi possível falar com o provedor de IA: ' + String(e?.message || e).slice(0, 160), 'rede')
  } finally { clearTimeout(t) }
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { /* resposta não JSON */ }
  if (!res.ok) {
    const msg = String(j?.error?.message || j?.message || text || res.statusText).slice(0, 240)
    const friendly = res.status === 401 || res.status === 403 ? 'Chave da API recusada pelo provedor (inválida, revogada ou sem permissão).'
      : res.status === 404 ? 'Modelo não encontrado neste provedor. Escolha outro modelo no painel da plataforma.'
      : res.status === 429 ? 'Limite de uso ou de crédito do provedor atingido. Confira o saldo e os limites na conta do provedor.'
      : res.status >= 500 ? 'O provedor de IA está instável no momento. Tente de novo em instantes.' : 'O provedor de IA recusou a requisição.'
    throw new AiError(`${friendly} (${p} ${res.status}: ${msg})`, 'provedor', res.status)
  }
  return j
}

/** Junta mensagens seguidas do mesmo papel e garante que a conversa comece pelo usuário. */
function normalize(history: Turn[]): Turn[] {
  const out: Turn[] = []
  for (const h of history) {
    if (!h.text?.trim()) continue
    if (out.length && out[out.length - 1].role === h.role) out[out.length - 1] = { role: h.role, text: out[out.length - 1].text + '\n\n' + h.text }
    else out.push({ ...h })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}
const safeJson = (s: string) => { try { return s ? JSON.parse(s) : {} } catch { return {} } }
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

export async function runLoop(i: LoopInput): Promise<LoopOutput> {
  const maxSteps = i.maxSteps ?? 6, maxTokens = i.maxTokens ?? 2048, timeout = i.timeoutMs ?? 90_000
  const history = normalize(i.history)
  const calls: LoopOutput['calls'] = []
  let inTok = 0, outTok = 0

  if (i.provider === 'anthropic') {
    const msgs: any[] = history.map((h) => ({ role: h.role, content: h.text }))
    const tools = i.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    for (let step = 1; step <= maxSteps; step++) {
      const last = step === maxSteps
      const r = await http('anthropic', `${base('anthropic')}/v1/messages`, { headers: { 'x-api-key': i.key, 'anthropic-version': '2023-06-01' },
        body: { model: i.model, max_tokens: maxTokens, system: i.system, messages: msgs, ...(tools.length && !last ? { tools } : {}) } }, timeout)
      inTok += r?.usage?.input_tokens ?? 0; outTok += r?.usage?.output_tokens ?? 0
      const blocks: any[] = r?.content ?? []
      const uses = blocks.filter((b) => b.type === 'tool_use')
      if (r?.stop_reason === 'tool_use' && uses.length && !last) {
        msgs.push({ role: 'assistant', content: blocks })
        const results = []
        for (const u of uses) { calls.push({ name: u.name, args: u.input ?? {} }); results.push({ type: 'tool_result', tool_use_id: u.id, content: asText(await i.exec(u.name, u.input ?? {})) }) }
        msgs.push({ role: 'user', content: results })
        continue
      }
      return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), inputTokens: inTok, outputTokens: outTok, calls, steps: step }
    }
  }

  if (i.provider === 'openai') {
    const msgs: any[] = [{ role: 'system', content: i.system }, ...history.map((h) => ({ role: h.role, content: h.text }))]
    const tools = i.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    for (let step = 1; step <= maxSteps; step++) {
      const last = step === maxSteps
      const r = await http('openai', `${base('openai')}/v1/chat/completions`, { headers: { authorization: `Bearer ${i.key}` },
        body: { model: i.model, messages: msgs, max_completion_tokens: Math.max(maxTokens, 4096), ...(tools.length && !last ? { tools } : {}) } }, timeout)
      inTok += r?.usage?.prompt_tokens ?? 0; outTok += r?.usage?.completion_tokens ?? 0
      const m = r?.choices?.[0]?.message ?? {}
      if (m.tool_calls?.length && !last) {
        msgs.push(m)
        for (const tc of m.tool_calls) {
          const args = safeJson(tc.function?.arguments)
          calls.push({ name: tc.function?.name, args })
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: asText(await i.exec(tc.function?.name, args)) })
        }
        continue
      }
      const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? '').join('') : ''
      return { text: content.trim(), inputTokens: inTok, outputTokens: outTok, calls, steps: step }
    }
  }

  if (i.provider === 'gemini') {
    const contents: any[] = history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] }))
    // Gemini não aceita objeto sem propriedades: ferramentas sem argumentos vão sem "parameters"
    const decl = i.tools.map((t) => ({ name: t.name, description: t.description, ...(Object.keys(t.parameters.properties).length ? { parameters: t.parameters } : {}) }))
    for (let step = 1; step <= maxSteps; step++) {
      const last = step === maxSteps
      const r = await http('gemini', `${base('gemini')}/v1beta/models/${encodeURIComponent(i.model)}:generateContent`, { headers: { 'x-goog-api-key': i.key },
        body: { systemInstruction: { parts: [{ text: i.system }] }, contents, ...(decl.length && !last ? { tools: [{ functionDeclarations: decl }] } : {}), generationConfig: { maxOutputTokens: Math.max(maxTokens, 4096) } } }, timeout)
      inTok += r?.usageMetadata?.promptTokenCount ?? 0; outTok += (r?.usageMetadata?.candidatesTokenCount ?? 0) + (r?.usageMetadata?.thoughtsTokenCount ?? 0)
      const parts: any[] = r?.candidates?.[0]?.content?.parts ?? []
      const fcs = parts.filter((p) => p.functionCall)
      if (fcs.length && !last) {
        contents.push({ role: 'model', parts }) // devolve as partes como vieram (inclui assinaturas de raciocínio)
        const responses = []
        for (const p of fcs) { calls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {} }); responses.push({ functionResponse: { name: p.functionCall.name, response: { result: await i.exec(p.functionCall.name, p.functionCall.args ?? {}) } } }) }
        contents.push({ role: 'user', parts: responses })
        continue
      }
      const blocked = r?.promptFeedback?.blockReason || (r?.candidates?.[0]?.finishReason === 'SAFETY' ? 'SAFETY' : null)
      const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim()
      if (!text && blocked) throw new AiError('O provedor bloqueou a resposta por política de conteúdo.', 'bloqueio')
      return { text, inputTokens: inTok, outputTokens: outTok, calls, steps: step }
    }
  }
  throw new AiError('Provedor de IA desconhecido.', 'config')
}

/** Lista os modelos disponíveis para a chave (para o painel da plataforma escolher). */
export async function listModels(provider: Provider, key: string): Promise<string[]> {
  if (provider === 'anthropic') {
    const r = await http('anthropic', `${base('anthropic')}/v1/models?limit=100`, { method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, 20_000)
    return (r?.data ?? []).map((m: any) => m.id).filter(Boolean)
  }
  if (provider === 'openai') {
    const r = await http('openai', `${base('openai')}/v1/models`, { method: 'GET', headers: { authorization: `Bearer ${key}` } }, 20_000)
    return (r?.data ?? []).map((m: any) => m.id).filter((id: string) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct)/.test(id)).sort()
  }
  const r = await http('gemini', `${base('gemini')}/v1beta/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': key } }, 20_000)
  return (r?.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent') && /gemini/.test(m.name)).map((m: any) => String(m.name).replace(/^models\//, ''))
}
