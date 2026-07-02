import { useState } from 'react';
import './LoginScreen.css';

const ROLES = ['viewer', 'operator', 'admin'];

export function LoginScreen({
  onDevLogin,
}: {
  onDevLogin: (email: string, role: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(ROLES[0]);

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">Sign in</h1>
        <a className="login-sso-button" href="/auth/login">
          Sign in with SSO
        </a>

        <div className="login-divider" />

        <div className="login-dev-section">
          <p className="login-dev-caption">
            Dev mode only — requires AUTH_DEV_MODE=1 on the backend
          </p>
          <input
            className="login-dev-input"
            type="email"
            placeholder="email@example.com"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            className="login-dev-select"
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="login-dev-button"
            onClick={() => onDevLogin(email, role)}
          >
            Dev sign in
          </button>
        </div>
      </div>
    </div>
  );
}
