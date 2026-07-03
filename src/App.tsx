import { LoginScreen } from './components/LoginScreen';
import { OnboardingBanner } from './components/OnboardingBanner';
import { CommandPalette } from './components/CommandPalette';
import { VaultSetup } from './components/VaultSetup';
import { NocStatusBar } from './components/NocStatusBar';
import { HubView } from './components/HubView';
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
        <HubView />
        <CommandPalette onLogout={logout} onManageVault={() => setShowVaultManager(true)} />
      </div>
    </VaultSetup>
  );
}

export default App;
