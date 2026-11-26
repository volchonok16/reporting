import { forwardRef, type ReactNode } from 'react';

type AlertProps = {
  title: string;
  children: ReactNode;
  tone?: 'info' | 'warning' | 'danger';
};

/** Persistent content. Dynamic announcement belongs to the screen's single live region. */
export function Alert({ title, children, tone = 'info' }: AlertProps) {
  return <div className="alert" data-tone={tone}>
    <p className="alert-title"><span aria-hidden="true">{tone === 'info' ? 'ⓘ' : '!'}</span> {title}</p>
    <div>{children}</div>
  </div>;
}

export type FieldError = { fieldId: string; message: string };

export const ErrorSummary = forwardRef<HTMLDivElement, { id: string; title: string; errors: readonly FieldError[] }>(
  function ErrorSummary({ id, title, errors }, ref) {
    return <div className="alert error-summary" data-tone="danger" id={id} ref={ref} tabIndex={-1} aria-labelledby={`${id}-title`}>
      <h3 className="alert-title" id={`${id}-title`}>{title}</h3>
      <ul>
        {errors.map(({ fieldId, message }) => <li key={fieldId}>
          <a href={`#${fieldId}`} onClick={(event) => {
            const field = document.getElementById(fieldId);
            if (field) { event.preventDefault(); field.focus(); field.scrollIntoView({ block: 'center' }); }
          }}>{message}</a>
        </li>)}
      </ul>
    </div>;
  },
);
