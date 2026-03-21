import { Tag } from 'lucide-react';

export default function NamedValues() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Named Values</h1>
        <p className="page-description">
          Manage named value pairs used in API policies and configurations.
        </p>
      </div>
      <div className="page-empty">
        <Tag className="page-empty-icon" />
        <div className="page-empty-title">No named values defined</div>
        <p className="page-empty-text">
          Named values store reusable configuration data like secrets, connection strings, and endpoints.
        </p>
      </div>
    </div>
  );
}
