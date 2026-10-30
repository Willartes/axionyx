import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../../shared/icon.component';
import { StateComponent } from '../../shared/ui';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { FMT } from '../../core/format';

const DOC_LABEL: Record<string, string> = { lido: 'Lidos', sem_texto: 'Sem texto (escaneados)', nao_suportado: 'Formato não lido', bloqueado: 'Dados de saúde (nunca lidos)', erro: 'Erro na leitura', nao_lido: 'Aguardando leitura' };

/** IA da empresa: ativação com aceite, documentos que a IA pode consultar, pastas bloqueadas e uso do mês. */
@Component({
  selector: 'ax-ia-empresa',
  imports: [FormsModule, IconComponent, StateComponent, ...FMT],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .lbl { font-size:11px; font-weight:600; color:#647687; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; display:block; }
    .term { font-size:12.5px; color:#334B5F; line-height:1.6; background:#F8FAFC; border:1px solid #E3EAF1; border-radius:8px; padding:12px 14px; }
    .chip { display:inline-flex; gap:6px; align-items:center; font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid #DCE4EC; background:white; cursor:pointer; }
    .chip.on { border-color:#C93636; background:#FDECEC; color:#8A1F1F; }
  `],
  template: `
  <div style="padding:24px;max-width:980px;display:flex;flex-direction:column;gap:16px">
    <div>
      <h1 style="font-size:20px;font-weight:700;color:#172B3A;display:flex;gap:8px;align-items:center"><ax-icon name="bot" [size]="20" color="#0875D1" /> Inteligência Artificial</h1>
      <p style="font-size:13px;color:#647687;margin-top:4px">A AXIA tem dois motores: o <b>motor de regras</b> (sempre disponível, calcula tudo dentro do AXIONYX) e a <b>IA generativa</b> (opcional, conversa e lê documentos). Cada usuário escolhe o motor na própria AXIA.</p>
    </div>
    <ax-state [loading]="!s()" />
    @if (s(); as s) {
      <div class="card" style="padding:18px 20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
          <div><span class="lbl">IA generativa</span>
            @if (s.available) { <div style="font-size:15px;font-weight:700;color:#18864B;display:flex;gap:6px;align-items:center"><ax-icon name="check-circle-2" [size]="16" color="#18864B" /> Ativa · {{ s.providerLabel }}</div>
              <div class="muted" style="font-size:12px">Ativada por {{ s.acceptedBy || '—' }} em {{ s.acceptedAt | dtt }}</div> }
            @else { <div style="font-size:14px;font-weight:600;color:#172B3A">{{ s.enabled && s.reason === 'limite' ? 'Limite do mês atingido' : 'Desativada' }}</div><div class="muted" style="font-size:12px">{{ s.reasonText }}</div> }
          </div>
          <div style="text-align:right"><span class="lbl">Uso no mês</span><div class="mono" style="font-size:18px;font-weight:700">{{ s.used }} <span class="muted" style="font-size:12px">/ {{ s.limit }} perguntas</span></div></div>
        </div>
        @if (!s.enabled && s.platformAllowed && s.reason !== 'sem_provedor' && s.reason !== 'sem_chave' && s.reason !== 'demo') {
          <div class="term">
            <b>Antes de ativar, leia:</b><br />
            • As perguntas feitas com a IA generativa, e os dados necessários para respondê-las, são enviados ao provedor de IA escolhido pela plataforma ({{ s.providerLabel }}), que processa os dados fora do Brasil, conforme os termos de uso por API dele.<br />
            • A IA só consulta o que cada usuário já pode ver no sistema. Prontuário, dados clínicos e salários nunca são enviados.<br />
            • As respostas são geradas automaticamente e podem conter erros. A "consulta jurídica" é uma pré-análise e não substitui o advogado.<br />
            • Cada pergunta fica registrada (quem, quando e quais dados ou documentos foram consultados) para auditoria.<br />
            <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-weight:600;cursor:pointer"><input type="checkbox" [(ngModel)]="accept" style="margin-top:3px" /> Li e aceito, em nome da empresa, o uso da IA generativa nestas condições.</label>
          </div>
          <div><button class="btn-primary" [disabled]="!accept || busy()" (click)="save({ enabled: true, accept: true }, 'IA ativada para a empresa.')"><ax-icon name="power" [size]="13" /> Ativar IA generativa</button></div>
        }
        @if (s.enabled) { <div><button class="btn-ghost" style="color:#C93636;font-size:12px" [disabled]="busy()" (click)="disable()">Desativar a IA generativa</button></div> }
      </div>

      <div class="card" style="padding:18px 20px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
          <div><span class="lbl">Documentos</span><div style="font-size:13px;color:#172B3A;max-width:560px">A IA pode buscar e ler os documentos enviados em <b>Documentos</b> (contratos, políticas, notas, planilhas), citando o documento e a página. Documentos de saúde nunca são lidos.</div></div>
          <label style="display:flex;gap:8px;align-items:center;font-size:13px;font-weight:600;cursor:pointer"><input type="checkbox" [ngModel]="s.documentsEnabled" (ngModelChange)="save({ documentsEnabled: $event }, $event ? 'A IA pode consultar os documentos.' : 'A IA não consulta mais os documentos.')" /> Permitir que a IA consulte documentos</label>
        </div>
        <div><span class="lbl">Pastas bloqueadas para a IA</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            @for (f of folders(); track f) { <button class="chip" [class.on]="blocked().includes(f)" (click)="toggleFolder(f)"><ax-icon [name]="blocked().includes(f) ? 'lock' : 'folder'" [size]="12" /> {{ f }}</button> }
            @if (!folders().length) { <span class="muted" style="font-size:12px">Nenhuma pasta com documentos ainda.</span> }
          </div>
          <div class="muted" style="font-size:11px;margin-top:6px">Clique para bloquear ou liberar. Documentos em pastas bloqueadas não aparecem nas buscas da IA.</div></div>
        <div><span class="lbl">Leitura dos documentos</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap">@for (d of s.documentsStatus; track d.status) { <span class="badge badge-muted" style="font-size:12px">{{ docLabel(d.status) }}: {{ d.n }}</span> }</div>
          @if (auth.can('documentos.editar')) { <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn-secondary" style="font-size:12px" [disabled]="busy()" (click)="index(false)"><ax-icon name="file-text" [size]="12" /> Ler documentos pendentes</button>
            <button class="btn-ghost" style="font-size:12px" [disabled]="busy()" (click)="index(true)">Ler todos de novo</button></div> }
          <div class="muted" style="font-size:11px;margin-top:6px">Lê PDF com texto, Word (.docx), Excel (.xlsx), CSV, XML (inclui NF-e) e texto. PDF escaneado e imagens ainda não são lidos.</div></div>
      </div>

      @if (s.recent.length) {
        <div class="card" style="overflow:hidden">
          <div style="padding:12px 16px;border-bottom:1px solid #F0F4F8;font-size:13px;font-weight:700;color:#172B3A">Últimas perguntas à IA generativa</div>
          <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;min-width:560px">
            <thead><tr><th>Quando</th><th>Quem</th><th>Modo</th><th>Consultas feitas</th><th>Situação</th></tr></thead>
            <tbody>@for (r of s.recent; track $index) { <tr><td class="mono" style="font-size:12px">{{ r.created_at | dtt }}</td><td>{{ r.user_name }}</td><td>{{ r.mode === 'juridico' ? 'Jurídico' : 'Geral' }}</td>
              <td style="font-size:12px">{{ r.tools_used?.join(', ') || '—' }}</td><td><span class="badge" [class]="r.status === 'ok' ? 'badge badge-success' : 'badge badge-warning'">{{ r.status === 'ok' ? 'Respondida' : r.status }}</span></td></tr> }</tbody>
          </table></div>
          <div class="muted" style="padding:8px 16px;font-size:11px">A pergunta fica registrada; a resposta não é guardada.</div>
        </div>
      }
    }
  </div>`,
})
export class IaEmpresaPage implements OnInit {
  private api = inject(Api); private toast = inject(ToastService); readonly auth = inject(AuthService);
  readonly s = signal<any>(null); readonly busy = signal(false);
  readonly folders = signal<string[]>([]); readonly blocked = signal<string[]>([]);
  accept = false;
  async ngOnInit() { await this.load(); }
  async load() { const s = await this.api.get<any>('/ai/settings'); this.s.set(s); this.folders.set(s.folders); this.blocked.set(s.blockedFolders ?? []); }
  docLabel(st: string) { return DOC_LABEL[st] ?? st; }
  async save(body: any, ok: string) { this.busy.set(true); try { await this.api.put('/ai/settings', body); this.toast.success(ok); await this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); } }
  disable() { if (confirm('Desativar a IA generativa para toda a empresa? A AXIA continua respondendo pelo motor de regras.')) this.save({ enabled: false }, 'IA generativa desativada.'); }
  toggleFolder(f: string) { const b = this.blocked().includes(f) ? this.blocked().filter((x) => x !== f) : [...this.blocked(), f]; this.save({ blockedFolders: b }, this.blocked().includes(f) ? `Pasta "${f}" liberada para a IA.` : `Pasta "${f}" bloqueada para a IA.`); }
  async index(force: boolean) { this.busy.set(true); try { const r = await this.api.post<any>('/ai/documents/index', { force }); this.toast.success(`${r.processed} documento(s) processado(s).`); await this.load(); } catch (e) { this.toast.error(e); } finally { this.busy.set(false); } }
}
