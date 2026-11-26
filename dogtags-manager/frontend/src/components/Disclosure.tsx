import type { ReactNode } from 'react';

export function Disclosure({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return <div id={id} className={`animated-disclosure${open ? ' is-open' : ''}`} aria-hidden={!open} inert={!open}>
    <div className="animated-disclosure-content">{children}</div>
  </div>;
}
