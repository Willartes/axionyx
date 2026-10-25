import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent } from '../shared/icon.component';

@Component({
  selector: 'ax-no-permission',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="empty-state" style="padding:80px 24px">
    <ax-icon name="shield-alert" [size]="40" color="#C93636" />
    <h2 style="font-size:16px;color:#172B3A;margin:12px 0 4px">Acesso negado</h2>
    <p>Seu perfil não possui permissão para esta tela. Solicite acesso ao administrador.</p>
    <button class="btn-secondary" style="margin-top:16px" (click)="router.navigateByUrl('/dashboard')">Voltar ao início</button></div>`,
})
export class NoPermissionPage { readonly router = inject(Router); }

@Component({
  selector: 'ax-not-found',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="empty-state" style="padding:80px 24px">
    <ax-icon name="search-x" [size]="40" color="#A0AFBF" />
    <h2 style="font-size:16px;color:#172B3A;margin:12px 0 4px">Página não encontrada</h2>
    <button class="btn-secondary" style="margin-top:16px" (click)="router.navigateByUrl('/dashboard')">Voltar ao início</button></div>`,
})
export class NotFoundPage { readonly router = inject(Router); }
