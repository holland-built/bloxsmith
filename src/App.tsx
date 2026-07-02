import { NetworkVertical } from './components/NetworkVertical';
import { TriagePanel } from './components/TriagePanel';
import { LoginScreen } from './components/LoginScreen';
import { AuditExportButton } from './components/AuditExportButton';
import { OnboardingBanner } from './components/OnboardingBanner';
import { CommandPalette } from './components/CommandPalette';
import { useAuth } from './hooks/useAuth';

function App() {
  const { user, loading, devLogin, logout } = useAuth();

  if (loading) return null;
  if (!user) return <LoginScreen onDevLogin={devLogin} />;

  return (
    <div className="app-stack">
      <OnboardingBanner />
      {user.role === 'admin' && <AuditExportButton />}
      <TriagePanel />
      <NetworkVertical />
      <CommandPalette onLogout={logout} />
    </div>
  );
}

export default App;
