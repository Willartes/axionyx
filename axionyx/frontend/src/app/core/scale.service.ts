import { Injectable, signal } from '@angular/core';

/**
 * Leitura de balança pelo navegador (Web Serial API — Chrome/Edge no computador).
 * Protocolo padrão de balanças comerciais (Toledo, Filizola, Urano e compatíveis em modo "comunicação contínua/ENQ"):
 * envia ENQ (0x05) e lê a resposta com o peso em kg. Outros protocolos podem exigir configuração na balança.
 */
@Injectable({ providedIn: 'root' })
export class ScaleService {
  readonly supported = typeof navigator !== 'undefined' && 'serial' in navigator;
  readonly connected = signal(false);
  private port: any = null;

  private async getPort(baudRate: number) {
    const serial = (navigator as any).serial;
    if (!this.port) {
      const granted = await serial.getPorts();
      this.port = granted[0] ?? (await serial.requestPort());
    }
    if (!this.port.readable) await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.connected.set(true);
    return this.port;
  }

  /** Lê o peso atual (kg). Lança erro com mensagem amigável se não houver resposta válida. */
  async read(baudRate = 9600, timeoutMs = 2000): Promise<number> {
    if (!this.supported) throw new Error('Este navegador não permite ler a balança. Use o Google Chrome ou o Microsoft Edge no computador, ou digite o peso.');
    let port: any;
    try { port = await this.getPort(baudRate); } catch (e: any) { this.connected.set(false); throw new Error(e?.name === 'NotFoundError' ? 'Nenhuma balança selecionada.' : 'Não foi possível abrir a porta da balança: ' + (e?.message || e)); }
    const writer = port.writable.getWriter();
    try { await writer.write(new Uint8Array([0x05])); } finally { writer.releaseLock(); }
    const reader = port.readable.getReader();
    let text = '';
    const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (/\x03|\r|\n/.test(text) && /\d/.test(text)) break;
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
    const w = parseWeight(text);
    if (w === null) throw new Error('A balança não respondeu com um peso válido (confira o cabo, a velocidade e se o produto está estável no prato).');
    return w;
  }

  async disconnect() { try { await this.port?.close(); } catch { /* */ } this.port = null; this.connected.set(false); }
}

/** Extrai o peso (kg) da resposta: aceita "1.234", "01,234", "  1234" (gramas, 5 dígitos) e marcadores STX/ETX. */
export function parseWeight(raw: string): number | null {
  const s = raw.replace(/[\x00-\x1f]/g, ' ').trim()
  if (/[IN]{3,}|\bI{2,}\b/.test(s)) return null // instável / sobrecarga (I, N ou S repetidos em alguns protocolos)
  const dec = s.match(/(\d{1,3})[.,](\d{3})/)
  if (dec) return Math.round((Number(dec[1]) + Number(dec[2]) / 1000) * 1000) / 1000
  const grams = s.match(/\b(\d{5})\b/)
  if (grams) return Number(grams[1]) / 1000
  return null
}
