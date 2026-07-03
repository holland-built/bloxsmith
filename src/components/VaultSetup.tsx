import { useState } from 'react';
import { useVaultStatus } from '../hooks/useVaultStatus';
import './VaultSetup.css';

async function postJson(url: string, body: unknown): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok?: boolean; error?: string };
}

interface VaultSetupProps {
  children: React.ReactNode;
  forceManager?: boolean;
  onManagerClose?: () => void;
}

export function VaultSetup({ children, forceManager, onManagerClose }: VaultSetupProps) {
  const { status, loading, refetch } = useVaultStatus();
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  if (loading) return null;
  if (!status) return forceManager ? null : <>{children}</>;
  if (!forceManager && status.ready) return <>{children}</>;

  const run = async (action: () => Promise<{ ok?: boolean; error?: string }>) => {
    setPending(true);
    setError('');
    try {
      const result = await action();
      if (result.ok === false) {
        setError(result.error || 'Something went wrong');
      } else {
        refetch();
      }
    } catch {
      setError('Request failed');
    } finally {
      setPending(false);
    }
  };

  if (forceManager && status.ready) {
    return (
      <div className="vault-setup">
        <div className="vault-card">
          <h1 className="vault-title">API key settings</h1>
          {status.tenants.length === 0 ? (
            <p className="vault-caption">No keys configured.</p>
          ) : (
            <ul className="vault-tenant-list">
              {status.tenants.map((t) => (
                <li key={t.id} className="vault-tenant-item">
                  <span className="vault-tenant-label">{t.label}</span>
                  {t.id === status.active && <span className="vault-tenant-badge">active</span>}
                  <button
                    type="button"
                    className="vault-button vault-button--danger"
                    disabled={pending}
                    onClick={() => run(() => postJson('/api/vault/tenant-remove', { id: t.id }))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <hr className="vault-divider" />
          <p className="vault-caption">Add a new key:</p>
          <input
            className="vault-input"
            type="text"
            placeholder="Label (optional)"
            aria-label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="vault-input"
            type="password"
            placeholder="Infoblox API key"
            aria-label="Infoblox API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            type="button"
            className="vault-button"
            disabled={pending || !key}
            onClick={() => run(() => postJson('/api/vault/tenant', { label, key }))}
          >
            {pending ? 'Adding…' : 'Add key'}
          </button>
          {error && <p className="vault-error">{error}</p>}
          <button type="button" className="vault-button" onClick={onManagerClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (!status.exists) {
    return (
      <div className="vault-setup">
        <div className="vault-card">
          <h1 className="vault-title">Create your vault</h1>
          <p className="vault-caption">
            Set a passphrase to encrypt your Infoblox tenant keys at rest.
          </p>
          <input
            className="vault-input"
            type="password"
            placeholder="Passphrase"
            aria-label="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button
            type="button"
            className="vault-button"
            disabled={pending || !passphrase}
            onClick={() => run(() => postJson('/api/vault/init', { passphrase }))}
          >
            {pending ? 'Creating…' : 'Create vault'}
          </button>
          {error && <p className="vault-error">{error}</p>}
        </div>
      </div>
    );
  }

  if (!status.unlocked) {
    return (
      <div className="vault-setup">
        <div className="vault-card">
          <h1 className="vault-title">Unlock your vault</h1>
          <input
            className="vault-input"
            type="password"
            placeholder="Passphrase"
            aria-label="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button
            type="button"
            className="vault-button"
            disabled={pending || !passphrase}
            onClick={() => run(() => postJson('/api/vault/unlock', { passphrase }))}
          >
            {pending ? 'Unlocking…' : 'Unlock'}
          </button>
          {error && <p className="vault-error">{error}</p>}
          <hr className="vault-divider" />
          {!confirmReset ? (
            <button
              type="button"
              className="vault-link"
              onClick={() => setConfirmReset(true)}
            >
              Forgot passphrase? Reset vault…
            </button>
          ) : (
            <>
              <p className="vault-caption vault-caption--warn">
                This deletes all stored keys. Cannot be undone.
              </p>
              <button
                type="button"
                className="vault-button vault-button--danger"
                disabled={pending}
                onClick={() => run(() => postJson('/api/vault/reset', { confirm: 'RESET' }))}
              >
                {pending ? 'Resetting…' : 'Yes, delete vault'}
              </button>
              <button
                type="button"
                className="vault-link"
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="vault-setup">
      <div className="vault-card">
        <h1 className="vault-title">Add your Infoblox API key</h1>
        <p className="vault-caption">
          Get a key: CSP portal → user menu → User API Keys → Create.
        </p>
        <input
          className="vault-input"
          type="text"
          placeholder="Label (optional)"
          aria-label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="vault-input"
          type="password"
          placeholder="Infoblox API key"
          aria-label="Infoblox API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="button"
          className="vault-button"
          disabled={pending || !key}
          onClick={() => run(() => postJson('/api/vault/tenant', { label, key }))}
        >
          {pending ? 'Adding…' : 'Add key'}
        </button>
        {error && <p className="vault-error">{error}</p>}
      </div>
    </div>
  );
}
