import { useState } from 'react';
import './OnboardingBanner.css';

const STORAGE_KEY = 'noc.onboarding.dismissed';

function isDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function OnboardingBanner() {
  const [dismissed, setDismissed] = useState(isDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // localStorage unavailable (private mode, etc.) -- dismiss for this session only
    }
    setDismissed(true);
  };

  return (
    <div className="onboarding-banner" role="status">
      <p>
        Triage shows what needs attention now. Subnets, leases, and zones are below.
        Press <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> to search or jump to a section.
      </p>
      <button type="button" className="onboarding-dismiss" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
