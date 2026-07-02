import { NetworkVertical } from './components/NetworkVertical';
import { TriagePanel } from './components/TriagePanel';
import { LoginScreen } from './components/LoginScreen';
import { AuditExportButton } from './components/AuditExportButton';
import { OnboardingBanner } from './components/OnboardingBanner';
import { CommandPalette } from './components/CommandPalette';
import { VaultSetup } from './components/VaultSetup';
import { useAuth } from './hooks/useAuth';

function App() {
  const { user, loading, devLogin, logout } = useAuth();

  if (loading) return null;
  if (!user) return <LoginScreen onDevLogin={devLogin} />;

  return (
    <VaultSetup>
      <div className="app-stack">
        <OnboardingBanner />
        {user.role === 'admin' && <AuditExportButton />}
        <TriagePanel />
        <NetworkVertical />
        <CommandPalette onLogout={logout} />
      </div>
    </VaultSetup>
  );
}

export default App;
