// What a box that holds a secret tells a password manager.
//
// Two kinds, and the owner chose the split on 2026-10-05:
//
//   a passphrase  the vault's own. A password manager may save and fill it, so
//                 the boxes say `new-password` (creating the vault, and
//                 confirming it) or `current-password` (unlocking it). Written
//                 on the box, not here: it differs per screen.
//   an API key    an Infoblox or Groq key, or the dashboard token. Pasted from
//                 somewhere else, never typed, and not a login: a manager that
//                 offers to save it as one, or fills a saved password into it,
//                 is wrong both ways. These boxes spread API_KEY_BOX.
//
// WHAT API_KEY_BOX CAN AND CANNOT DO. It asks; it cannot make anyone stay out.
// `autoComplete="off"` is a request that Chrome and Firefox may ignore on a
// password box and that Safari ignores. The three data attributes are the ones
// 1Password, LastPass and Bitwarden document for "leave this field alone", and
// they reach those extensions only. There is no field-level switch that keeps
// a browser's own password manager out. Nothing here was tried against a real
// password manager.
export const API_KEY_BOX = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
}
