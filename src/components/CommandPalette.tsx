import { useEffect, useRef, useState } from 'react';
import { useNetworkData } from '../hooks/useNetworkData';
import { drillTo } from '../lib/drilldown';
import './CommandPalette.css';

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  onLogout: () => void;
  onManageVault: () => void;
}

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function CommandPalette({ onLogout, onManageVault }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useNetworkData();

  const close = () => setOpen(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          const next = !prev;
          if (next) {
            setQuery('');
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 0);
          }
          return next;
        });
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const commands: PaletteItem[] = [
    { id: 'cmd-triage', label: 'Triage', run: () => scrollToSection('section-triage') },
    { id: 'cmd-subnets', label: 'Subnets', run: () => scrollToSection('section-subnets') },
    { id: 'cmd-leases', label: 'Leases', run: () => scrollToSection('section-leases') },
    { id: 'cmd-zones', label: 'Zones', run: () => scrollToSection('section-zones') },
    { id: 'cmd-vault', label: 'API key settings', run: () => { close(); onManageVault(); } },
    { id: 'cmd-logout', label: 'Log out', run: () => { close(); onLogout(); } },
  ];

  const ql = query.toLowerCase().trim();

  const dataMatches: PaletteItem[] =
    ql.length >= 2
      ? [
          ...(data?.subnets ?? [])
            .filter((s) => s.name.toLowerCase().includes(ql) || s.addr.toLowerCase().includes(ql))
            .slice(0, 6)
            .map((s) => ({
              id: `subnet-${s.id}`,
              label: s.name || s.addr,
              hint: 'Subnet',
              run: () => drillTo('subnet', s.id),
            })),
          ...(data?.zones ?? [])
            .filter((z) => z.fqdn.toLowerCase().includes(ql))
            .slice(0, 6)
            .map((z) => ({
              id: `zone-${z.id}`,
              label: z.fqdn,
              hint: 'Zone',
              run: () => drillTo('zone', z.id),
            })),
        ]
      : [];

  const filteredCommands = commands.filter((c) => !ql || c.label.toLowerCase().includes(ql));
  const items: PaletteItem[] = [...dataMatches, ...filteredCommands];

  const selectItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectItem(items[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={close}>
      <div
        className="cmdk-box"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Jump to a section or search…"
          aria-label="Command palette"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="cmdk-list">
          {items.length === 0 ? (
            <div className="cmdk-empty">No matches</div>
          ) : (
            items.map((item, i) => (
              <div
                key={item.id}
                className={`cmdk-item${i === selectedIndex ? ' selected' : ''}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => selectItem(item)}
                role="option"
                aria-selected={i === selectedIndex}
              >
                <span className="cmdk-label">{item.label}</span>
                {item.hint && <span className="cmdk-hint">{item.hint}</span>}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
