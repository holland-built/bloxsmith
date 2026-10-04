// Attributes for a box that holds text a machine reads: an address, a host
// name, an object id, a filter. Spread onto the <input>.
//
// Left to itself a browser treats every text box as prose. It underlines
// "cl1-dns-ms-agent" as a spelling mistake, offers last week's filter text in a
// dropdown that covers the table being filtered, and on a phone capitalises the
// first letter of a host name. None of that helps here.
//
// NOT for prose (a comment, a question to the assistant, a display name), where
// spell-check is the point, and NOT for a passphrase, a token or an API key:
// what a password manager may do with those is a decision of its own, and those
// boxes are left exactly as they were. lib/machineText.test.js holds the list.
export const MACHINE_TEXT = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false }
