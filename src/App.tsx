import { NetworkVertical } from './components/NetworkVertical';
import { LoginScreen } from './components/LoginScreen';
import { OnboardingBanner } from './components/OnboardingBanner';
import { CommandPalette } from './components/CommandPalette';
import { VaultSetup } from './components/VaultSetup';
import { McpIncidentQueue } from './components/McpIncidentQueue';
import { McpEventStream } from './components/McpEventStream';
import { NocStatusBar } from './components/NocStatusBar';
import { useState } from 'react';
import { useAuth } from './hooks/useAuth';

function App() {
  const { user, loading, devLogin, logout } = useAuth();
  const [showVaultManager, setShowVaultManager] = useState(false);

  if (loading) return null;
  if (!user) return <LoginScreen onDevLogin={devLogin} />;

  return (
    <VaultSetup
      forceManager={showVaultManager}
      onManagerClose={() => setShowVaultManager(false)}
    >
      <div className="noc-layout">
        <OnboardingBanner />
        <NocStatusBar
          isAdmin={user.role === 'admin'}
          onManageVault={() => setShowVaultManager(true)}
          onLogout={logout}
        />
        <div className="noc-grid">
          <div className="noc-col-left">
            <McpIncidentQueue />
          </div>
          <div className="noc-col-right">
            <div className="noc-network-pane">
              <NetworkVertical />
            </div>
            <div className="noc-events-pane">
              <McpEventStream />
            </div>
          </div>
        </div>
        <CommandPalette onLogout={logout} onManageVault={() => setShowVaultManager(true)} />
      </div>
    </VaultSetup>
  );
}

export default App;
