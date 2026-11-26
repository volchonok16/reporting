import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

export function ConfirmDialog({ title, busy, onConfirm, onCancel, children, confirmLabel = 'Подтвердить удаление', destructive = true }: {
  title: string; busy: boolean; onConfirm: () => void; onCancel: () => void;
  children?: ReactNode; confirmLabel?: string; destructive?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!, previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow; element.showModal(); element.querySelector<HTMLButtonElement>('[data-dialog-cancel]')?.focus(); document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel(); } }}>
    <h2 id="confirm-dialog-title">{title}</h2>
    {children}
    <div className="actions"><Button variant={destructive ? 'danger' : 'primary'} disabled={busy} loading={busy} onClick={onConfirm}>{confirmLabel}</Button><Button data-dialog-cancel autoFocus disabled={busy} onClick={onCancel}>Отмена</Button></div>
  </dialog>;
}
