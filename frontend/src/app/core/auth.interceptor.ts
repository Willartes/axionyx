import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const token = auth.token();
  const r = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(r).pipe(catchError((e) => {
    if (e?.status === 401 && !req.url.includes('/auth/login') && !req.url.includes('/auth/mfa')) {
      auth.clear();
      router.navigateByUrl('/login?expirada=1');
    }
    return throwError(() => e);
  }));
};
