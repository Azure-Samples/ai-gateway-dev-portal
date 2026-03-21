import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  BrainCog,
  CloudCog,
  Plug,
  Bot,
  Package,
  KeyRound,
  Play,
  Coins,
  Gauge,
  ShieldCheck,
  Activity,
  ScrollText,
  FlaskConical,
  ClipboardCheck,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

type NavEntry =
  | { type: 'link'; to: string; label: string; Icon: typeof LayoutDashboard }
  | { type: 'divider' }
  | { type: 'group-label'; label: string };

const navItems: NavEntry[] = [
  { type: 'link', to: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { type: 'divider' },
  { type: 'link', to: '/model-providers', label: 'Model providers', Icon: CloudCog },
  { type: 'link', to: '/inference-apis', label: 'Inference APIs', Icon: BrainCog },
  { type: 'link', to: '/mcp-servers', label: 'MCP servers', Icon: Plug },
  { type: 'link', to: '/a2a', label: 'A2A integrations', Icon: Bot },
  { type: 'link', to: '/products', label: 'Products', Icon: Package },
  { type: 'link', to: '/subscriptions', label: 'Subscriptions', Icon: KeyRound },
  { type: 'divider' },
  { type: 'link', to: '/playground', label: 'Playground', Icon: Play },
  { type: 'link', to: '/labs', label: 'Labs', Icon: FlaskConical },
  { type: 'divider' },
  { type: 'link', to: '/logs', label: 'Logs', Icon: ScrollText },
  { type: 'link', to: '/evals', label: 'Evals', Icon: ClipboardCheck },
  { type: 'group-label', label: 'Analytics' },
  { type: 'link', to: '/requests', label: 'Requests', Icon: Activity },
  { type: 'link', to: '/tokens', label: 'Tokens', Icon: Coins },
  { type: 'link', to: '/performance', label: 'Performance', Icon: Gauge },
  { type: 'link', to: '/availability', label: 'Availability', Icon: ShieldCheck },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <nav className="sidebar-nav">
        {navItems.map((item, i) =>
          item.type === 'divider' ? (
            <div key={`div-${i.toString()}`} className="sidebar-divider" />
          ) : item.type === 'group-label' ? (
            <div key={`grp-${i.toString()}`} className="sidebar-group-label">{item.label}</div>
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `sidebar-item${isActive ? ' active' : ''}`
              }
              title={collapsed ? item.label : undefined}
            >
              <item.Icon className="sidebar-item-icon" />
              <span className="sidebar-item-label">{item.label}</span>
            </NavLink>
          ),
        )}
      </nav>
      <button className="sidebar-toggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
    </aside>
  );
}
