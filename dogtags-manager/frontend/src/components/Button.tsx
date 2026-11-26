import type { ButtonHTMLAttributes } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
};

export function Button({ variant = 'secondary', loading = false, className = '', children, onClick, type = 'button', ...props }: ButtonProps) {
  return <button
    {...props}
    type={type}
    className={`button button--${variant} ${className}`}
    aria-busy={loading || undefined}
    aria-disabled={loading || props.disabled || undefined}
    onClick={(event) => {
      if (loading) { event.preventDefault(); return; }
      onClick?.(event);
    }}
  >
    <span className="button-indicator" data-active={loading} aria-hidden="true">↻</span>
    <span className="button-label">{children}</span>
  </button>;
}
