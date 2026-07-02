import { useState } from 'react';
import './AuditExportButton.css';

export function AuditExportButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function handleExport() {
    setPending(true);
    setError(false);

    try {
      const res = await fetch('/api/audit/export', {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-export-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="audit-export-button">
      <button
        type="button"
        className="audit-export-button-button"
        disabled={pending}
        onClick={handleExport}
      >
        {pending ? 'Exporting…' : 'Export Audit Log'}
      </button>
      {error && (
        <span className="audit-export-button-error">Export failed</span>
      )}
    </div>
  );
}
