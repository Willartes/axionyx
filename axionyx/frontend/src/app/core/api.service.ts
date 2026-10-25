import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface Paged<T> { items: T[]; total: number; page: number; size: number; pages: number; totals?: any; [k: string]: any; }
export interface ApiErrorDetail { path?: string; field?: string; message: string; }

/** Erro normalizado da API (mensagem em português vinda do servidor). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) for (const d of this.details) if (d.path || d.field) out[d.path || d.field] = d.message;
    return out;
  }
}

/** Gera chave de idempotência para operações que alteram estoque/financeiro. */
export function newIdempotencyKey(): string {
  const c: any = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private base = '/api';

  private params(q?: Record<string, any>): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q || {})) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return p;
  }
  private async run<T>(obs: any): Promise<T> {
    try { return await firstValueFrom(obs) as T; }
    catch (e: any) {
      if (e instanceof HttpErrorResponse) {
        const err = e.error?.error;
        if (e.status === 0) throw new ApiError(0, 'rede', 'Não foi possível conectar ao servidor. Verifique sua conexão.');
        throw new ApiError(e.status, err?.code || 'erro', err?.message || `Erro ${e.status}`, err?.details);
      }
      throw e;
    }
  }
  get<T = any>(path: string, query?: Record<string, any>): Promise<T> {
    return this.run<T>(this.http.get<T>(this.base + path, { params: this.params(query) }));
  }
  post<T = any>(path: string, body?: any, opts: { idempotent?: boolean | string } = {}): Promise<T> {
    let headers = new HttpHeaders();
    if (opts.idempotent) headers = headers.set('Idempotency-Key', typeof opts.idempotent === 'string' ? opts.idempotent : newIdempotencyKey());
    return this.run<T>(this.http.post<T>(this.base + path, body ?? {}, { headers }));
  }
  put<T = any>(path: string, body?: any): Promise<T> { return this.run<T>(this.http.put<T>(this.base + path, body ?? {})); }
  delete<T = any>(path: string): Promise<T> { return this.run<T>(this.http.delete<T>(this.base + path)); }
  /** Envia conteúdo bruto (XML, extrato, arquivo). */
  raw<T = any>(path: string, body: Blob | string, contentType: string, headers: Record<string, string> = {}): Promise<T> {
    let h = new HttpHeaders({ 'content-type': contentType, ...headers });
    return this.run<T>(this.http.post<T>(this.base + path, body, { headers: h }));
  }
  /** Obtém arquivo autenticado como Blob (pré-visualização). */
  blob(path: string, query?: Record<string, any>): Promise<Blob> { return this.run<Blob>(this.http.get(this.base + path, { params: this.params(query), responseType: 'blob' })); }
  /** Baixa arquivo autenticado (CSV, JSON, XML, documentos). */
  async download(path: string, query?: Record<string, any>, fallbackName = 'arquivo'): Promise<void> {
    const res: any = await this.run(this.http.get(this.base + path, { params: this.params(query), responseType: 'blob', observe: 'response' }));
    const cd = res.headers.get('content-disposition') || '';
    const name = decodeURIComponent(/filename="?([^";]+)"?/.exec(cd)?.[1] || fallbackName);
    const url = URL.createObjectURL(res.body);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
