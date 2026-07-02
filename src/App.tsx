import { NetworkVertical } from './components/NetworkVertical';
import { TriagePanel } from './components/TriagePanel';
import { LoginScreen } from './components/LoginScreen';
import { AuditExportButton } from './components/AuditExportButton';
import { useAuth } from './hooks/useAuth';

function App() {
  const { user, loading, devLogin } = useAuth();

  if (loading) return null;
  if (!user) return <LoginScreen onDevLogin={devLogin} />;

  return (
    <div className="app-stack">
      {user.role === 'admin' && <AuditExportButton />}
      <TriagePanel />
      <NetworkVertical />
    </div>
  );
}

export default App;
