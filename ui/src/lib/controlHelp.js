// ---------------------------------------------------------------------------
// CONTROL_HELP — one plain-English line per control in the app header.
//
// WHY THIS IS A SEPARATE FILE FROM panelHelp.js. Not tidiness: the two
// dictionaries have different guarantees, and merging them would let the weaker
// one borrow the stronger one's reputation. PANEL_HELP is enforced — every
// panel goes through one shell, so a scanner can prove no panel is missing.
// The header controls have no shell; they are six unrelated components in one
// flex row, and nothing static can prove a seventh has an entry. Keeping them
// apart makes that difference visible at the import line.
//
// WHY IT EXISTS AT ALL. Every control here explained itself only through a
// `title=` hover tooltip, which this codebase already rejects as an affordance
// (see the comment above TabIntro in components/ui.jsx: the nav collapses at
// narrow widths and hover does not exist on touch). The reported symptom was
// exactly that — "I didn't know what the compact was at the top". The two icons
// in the density switch are three lines with air and three lines without; that
// drawing is the entire explanation the control ever gave.
//
// ---------------------------------------------------------------------------
// STYLE GUIDE — same voice as PANEL_HELP, read that file's header too.
//
//   label  What the control is called on screen, or what it looks like when it
//          has no name. A reader matches this against the header by eye, so it
//          has to be what they can see — "The coloured dot", not "ConnStatus".
//
//   what   One or two sentences: what the control does, and what changes when
//          you use it. Say the effect, never just re-read the label back —
//          "Compact fits more rows on screen" earns its place; "sets the
//          density" does not.
//
// Rules:
//   - Plain words. No jargon, no component names, no endpoint names.
//   - Describe only what the control actually does. The Provision button
//     navigates; it does not provision anything, and saying otherwise would be
//     a promise the app does not keep.
//   - Key order is the header's own left-to-right order, and the shape test
//     holds it there. A reader is looking at the row while they read this.
// ---------------------------------------------------------------------------

export const CONTROL_HELP = {
  'connection-status': {
    label: 'The coloured dot',
    what: 'Green means connected with data arriving. Amber means connected but nothing came back. Red means the vault is locked or a feed failed. The words beside it name the tenant, or say what went wrong.',
  },
  updates: {
    label: 'Update v…',
    what: 'Appears at the top of the screen only when a newer version exists, and nothing is shown there when you are already up to date. Pressing it installs that version and reloads the page.',
  },
  theme: {
    label: 'Sun · Monitor · Moon',
    what: 'Light, System, or Dark colours. System follows your computer and changes whenever your computer does.',
  },
  density: {
    label: 'The two row icons',
    what: 'Compact fits more rows on screen. Comfortable gives everything more space. It changes spacing only — no table loses a column and no panel is hidden.',
  },
  settings: {
    label: 'The ⋯ button',
    what: 'Connections, the CSP account, the dashboard token, and locking the vault. The theme and spacing controls are in here as well, which is where a narrow screen keeps them.',
  },
  provision: {
    label: '+ Provision',
    what: 'Goes to the Provision tab, where new networks, hosts and records are created. It only takes you there — pressing it changes nothing.',
  },
}
