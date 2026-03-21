import { Loader2, Check, AlertCircle } from 'lucide-react';
import { useAzure, type WorkspaceLoadStep } from '../context/AzureContext';

function StepIcon({ status }: { status: WorkspaceLoadStep['status'] }) {
  switch (status) {
    case 'loading':
      return <Loader2 size={14} className="wl-spin" />;
    case 'done':
      return <Check size={14} />;
    case 'error':
      return <AlertCircle size={14} />;
    default:
      return <span className="wl-dot" />;
  }
}

export default function LoadingModal() {
  const { workspaceLoading, workspaceLoadSteps, config } = useAzure();

  if (!workspaceLoading) return null;

  const done = workspaceLoadSteps.filter((s) => s.status === 'done' || s.status === 'error').length;
  const total = workspaceLoadSteps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="wl-overlay">
      <div className="wl-dialog">
        <div className="wl-logo-wrap">
          <img src="/ai-gateway.svg" alt="" className="wl-logo" />
          <div className="wl-logo-color" />
        </div>
        <div className="wl-title">Loading workspace data</div>
        <div className="wl-subtitle">{config.apimService?.name}</div>

        {/* Progress bar */}
        <div className="wl-progress-track">
          <div className="wl-progress-bar" style={{ width: `${pct}%` }} />
        </div>

        {/* Steps */}
        <div className="wl-steps">
          {workspaceLoadSteps.map((step) => (
            <div key={step.label} className={`wl-step wl-step-${step.status}`}>
              <StepIcon status={step.status} />
              <span>{step.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
