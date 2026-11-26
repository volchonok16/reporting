import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`control ${className}`} data-control {...props} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`control ${className}`} data-control {...props} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`control ${className}`} data-control {...props} />;
}

export function DateInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <Input {...props} type="date" />;
}

type ComboboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'list' | 'type'> & {
  id: string;
  options: readonly string[];
};

/** Native editable combobox: browser provides the list and its keyboard behavior. */
export function Combobox({ options, id, ...props }: ComboboxProps) {
  return <>
    <Input {...props} id={id} type="text" list={`${id}-options`} />
    <datalist id={`${id}-options`}>
      {options.map((option) => <option key={option} value={option} />)}
    </datalist>
  </>;
}
