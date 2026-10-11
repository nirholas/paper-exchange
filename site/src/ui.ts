import { esc } from './fmt.js';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

export function toast(message: string, kind: 'ok' | 'err' | 'info' = 'info') {
  const host = $('#toasts')!;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.classList.add('out'), 4_500);
  setTimeout(() => el.remove(), 5_000);
}

export function skeleton(rows = 6): string {
  return Array.from({ length: rows }, () => '<div class="skel"></div>').join('');
}

export function empty(title: string, hint: string, action = ''): string {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(hint)}</span>${action}</div>`;
}

export function errorBox(message: string, retryId = 'retry'): string {
  return `<div class="empty err"><strong>Could not load data</strong><span>${esc(message)}</span><button class="btn" id="${retryId}">Retry</button></div>`;
}

export function confirmDialog(title: string, body: string, ok = 'Confirm'): Promise<boolean> {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p>${esc(body)}</p><div class="row end"><button class="btn" value="no">Cancel</button><button class="btn primary" value="yes">${esc(ok)}</button></div></form>`;
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}

export type Page = { mount(root: HTMLElement): void | Promise<void>; unmount?(): void };
