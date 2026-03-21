import { ClipboardCheck } from 'lucide-react';

export default function Evals() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Evals</h1>
        <p className="page-description">
          Extract AI Gateway logs and run Model, Tools, and Agent evaluations.
        </p>
      </div>
      <div className="page-empty">
        <ClipboardCheck className="page-empty-icon" />
        <div className="page-empty-title">Coming soon</div>
        <p className="page-empty-text">
          Evals will let you extract LLM logs from the AI Gateway and run quality evaluations for models, tools, and agents.
        </p>
      </div>
    </div>
  );
}
