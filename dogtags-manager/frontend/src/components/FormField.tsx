import type { ReactNode } from 'react';

export type FieldControlProps = {
  id: string;
  required: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
};

type FormFieldProps = {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  children: (props: FieldControlProps) => ReactNode;
};

export function FormField({ id, label, help, error, required = false, optional = false, children }: FormFieldProps) {
  const description = [help ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div className="form-field" data-field={id}>
      <label className="field-label" htmlFor={id}>
        {label}{required && <span className="field-note"> (обязательно)</span>}
        {optional && !required && <span className="field-note"> (необязательно)</span>}
      </label>
      <div className="field-control">
        {children({ id, required, 'aria-describedby': description || undefined, 'aria-invalid': error ? true : undefined })}
      </div>
      <div className="field-support">
        {help && <p id={`${id}-help`}>{help}</p>}
        {error && <p className="field-error" id={`${id}-error`}>{error}</p>}
      </div>
      <div className="field-spacer" aria-hidden="true" />
    </div>
  );
}
