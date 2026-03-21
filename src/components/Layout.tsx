import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import LoadingModal from './LoadingModal';
import { useAzure } from '../context/AzureContext';

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { dataVersion } = useAzure();

  return (
    <div className={`app-layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Header />
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(c => !c)} />
      <main className="main-content">
        <Outlet key={dataVersion} />
      </main>
      <LoadingModal />
    </div>
  );
}
