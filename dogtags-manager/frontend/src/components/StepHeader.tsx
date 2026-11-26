type Step = { id: string; label: string };

export function StepHeader({ steps, currentStep, label = 'Этапы подготовки' }: { steps: readonly Step[]; currentStep: string; label?: string }) {
  return <nav aria-label={label} className="step-header"><ol>
    {steps.map((step, index) => <li key={step.id} aria-current={step.id === currentStep ? 'step' : undefined}>
      <span className="step-number" aria-hidden="true">{index + 1}</span><span>{step.label}</span>
    </li>)}
  </ol></nav>;
}
