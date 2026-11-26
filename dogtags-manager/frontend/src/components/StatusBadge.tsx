import { statusSemantics, type Status } from '../design/status-semantics';

export function StatusBadge({ status }: { status: Status }) {
  const { tone, label, icon } = statusSemantics[status];
  return <span className="status-badge" data-tone={tone}><span aria-hidden="true">{icon}</span>{label}</span>;
}
