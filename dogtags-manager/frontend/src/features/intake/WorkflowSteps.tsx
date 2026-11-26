import { workflowSteps } from './workflowState';
export type { WorkflowStep } from './workflowState';

export function WorkflowSteps({ current }: { current: number }) {
  return <ol className="workflow-steps" aria-label="Этапы обработки">
    {workflowSteps.map((title, index) => <li key={title} aria-current={current === index ? 'step' : undefined}
      className={index < current ? 'workflow-step--done' : undefined}>
      <span className="workflow-step-number" aria-hidden="true">{index < current ? '✓' : index + 1}</span>
      <span>{title}</span>
    </li>)}
  </ol>;
}
