const PREFIX: Record<string, string> = {
  subnet: 'subnet-',
  zone: 'zone-',
  lease: 'lease-',
};

const HIGHLIGHT_CLASS = 'drill-highlight';
const HIGHLIGHT_MS = 2000;

export function drillTo(entityType: string, entityId: string | undefined): void {
  if (!entityId) return;
  const prefix = PREFIX[entityType];
  if (!prefix) return;
  const target = document.getElementById(`${prefix}${entityId}`);
  if (!target) return;

  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => {
    target.classList.remove(HIGHLIGHT_CLASS);
  }, HIGHLIGHT_MS);
}
