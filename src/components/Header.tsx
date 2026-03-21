import SearchBar from './SearchBar';
import WorkspaceSelector from './WorkspaceSelector';
import UserMenu from './UserMenu';
import { Github } from 'lucide-react';

export default function Header() {

  return (
    <header className="header">
      {/* Left: Logo + Workspace */}
      <div className="header-left">
        <a href="/" className="header-logo-link">
          <img
            src="/ai-gateway.svg"
            alt="AI Gateway"
            className="header-logo-icon"
          />
          <span className="header-logo-text">AI Gateway</span>
        </a>
        <div className="header-separator" />
        <WorkspaceSelector />
      </div>

      {/* Center: Search */}
      <div className="header-center">
        <SearchBar />
      </div>

      {/* Right: Actions + User */}
      <div className="header-right">
        <a href="https://github.com/vieiraae/ai-gateway-dev-portal" target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label="GitHub" title="Fork the project on GitHub">
          <Github size={16} />
        </a>
        <UserMenu />
      </div>
    </header>
  );
}
