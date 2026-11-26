import { useId, type HTMLAttributes, type ReactNode } from 'react';

type SectionProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; titleLevel?: 2 | 3 };

/** Query containment belongs here, never on FormGrid or its subgrid children. */
export function FormSection({ className = '', title, titleLevel = 2, ...props }: SectionProps) {
  const generatedId = useId();
  const titleId = props['aria-labelledby'] ?? generatedId;
  const Heading = titleLevel === 3 ? 'h3' : 'h2';
  const body = <section className={`form-section ${className}`} {...props} aria-labelledby={title ? titleId : props['aria-labelledby']} />;
  return title ? <div className="form-block"><Heading id={titleId} className="block-title">{title}</Heading>{body}</div> : body;
}

export function FormGrid({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`form-grid ${className}`} {...props} />;
}
