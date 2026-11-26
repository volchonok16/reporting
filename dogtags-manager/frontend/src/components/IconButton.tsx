import type { ButtonHTMLAttributes } from 'react';

type IconName = 'edit' | 'eye' | 'download' | 'repeat' | 'trash' | 'back';

export function ActionIcon({ icon }: { icon: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icon === 'back' && <path d="M20 12H4m7-7-7 7 7 7" />}
    {icon === 'edit' && <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" />}
    {icon === 'eye' && <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>}
    {icon === 'download' && <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>}
    {icon === 'repeat' && <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" /></>}
    {icon === 'trash' && <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>}
  </svg>;
}

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  icon: IconName; label: string; danger?: boolean;
};
export function IconButton({ icon, label, danger = false, className = '', type = 'button', ...props }: Props) {
  return <button {...props} type={type} aria-label={label} title={label}
    className={`icon-button${danger ? ' icon-button--danger' : ''} ${className}`}><ActionIcon icon={icon} /></button>;
}
