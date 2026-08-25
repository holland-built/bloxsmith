// Package vault ports Bloxsmith's encrypted credential store from server.py
// (lines 2404-2416, 2750-3055). It reads and writes the on-disk format the
// Python app produced so an existing user's vault.json unlocks unchanged.
//
// On-disk format:
//   - cipher: Fernet (AES-128-CBC + HMAC-SHA256, standard token layout).
//   - KDF:    scrypt(passphrase, salt, N, r, p, dkLen) then
//     base64.urlsafe_b64encode(dk) -> the 44-char Fernet key. The scrypt
//     parameters are chosen by the envelope's "v" — see kdfByVersion.
//   - file:   {"v":N, "salt": <std-b64 of 16 salt bytes>, "data": <fernet token>}
//     at $VAULT_DIR/vault.json; plaintext is the JSON payload
//     {tenants, active, groq, llm_base, llm_model, write_allowed}.
package vault

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	fernet "github.com/fernet/fernet-go"
	"golang.org/x/crypto/scrypt"
)

// kdfParams is one generation of scrypt settings.
type kdfParams struct{ N, R, P, KeyLen int }

// kdfByVersion maps the envelope's "v" to the scrypt parameters that vault file
// was sealed with. THE MAP IS THE COMPATIBILITY CONTRACT: every version listed
// here is a vault this build can still open, so an entry may be reordered or
// documented but MUST NOT be deleted or have its numbers edited — changing 1's
// numbers does not re-encrypt anybody's file, it just makes every v1 vault on
// every disk report a wrong passphrase, permanently, with no recovery.
//
// The old comment on these constants said they "MUST match server.py:2769".
// That is no longer the constraint and has not been since the Python server was
// retired: server.py does not exist in this repo. The real constraint is the
// vault.json files already sitting on operators' disks, which is why the v1 row
// is frozen rather than tracking anyone's current recommendation.
var kdfByVersion = map[int]kdfParams{
	// What the Python server shipped, from Go's 2017 scrypt docs. Frozen.
	1: {N: 1 << 15, R: 8, P: 1, KeyLen: 32}, // 32 MiB
	// OWASP's current minimum for scrypt. 2^17 costs ~128 MiB per derive.
	2: {N: 1 << 17, R: 8, P: 1, KeyLen: 32},
}

// currentVaultVersion is what a NEW or re-keyed vault is written as. Unlock
// upgrades anything older in place (migrateLocked); it refuses anything newer,
// because a build that cannot derive the key cannot tell a wrong passphrase
// from an unsupported file and must not guess.
const currentVaultVersion = 2

// Tenant is one stored connection (server.py:2891 shape).
type Tenant struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Key   string `json:"key"`
}

// payload is the Fernet-encrypted plaintext (server.py:2773-2774 _vault_save).
//
// WriteAllowed is additive: a vault written before the per-tenant write lock has
// no such key, which decodes to nil — nothing writable. That is the correct
// default for an existing vault, not a migration gap. See writelock.go.
type payload struct {
	Tenants []Tenant `json:"tenants"`
	Active  *string  `json:"active"`
	Groq    string   `json:"groq"`
	// Axur is the brand-protection vendor's API credential, held whole the way
	// Groq is. Absent in every vault written before the Axur integration, which
	// decodes to "" — no Axur key stored, fall back to AXUR_API_KEY. That is the
	// right answer for an older file, not a migration gap, exactly as the
	// WriteAllowed comment above records for its own field.
	Axur         string   `json:"axur"`
	LLMBase      string   `json:"llm_base"`
	LLMModel     string   `json:"llm_model"`
	WriteAllowed []string `json:"write_allowed,omitempty"`
}

// fileEnvelope is the cleartext on-disk wrapper (server.py:2778).
//
// V WAS WRITTEN AND NEVER READ until the KDF migration: every writer hardcoded
// 1 and Unlock ignored it. It now SELECTS THE KDF (kdfByVersion), so it is load
// bearing in both directions — a file whose V does not match the parameters its
// token was actually sealed with is unopenable by anything, which is why save()
// takes V from v.ver (set beside v.key, never independently) instead of from a
// literal.
type fileEnvelope struct {
	V    int    `json:"v"`
	Salt string `json:"salt"` // std base64 of the 16 raw salt bytes
	Data string `json:"data"` // Fernet token string
}

// Vault mirrors the server.py _vault dict (2750) plus its file location.
type Vault struct {
	mu      sync.Mutex
	path    string
	BaseURL string // Infoblox base URL for portal name/key lookups (INFOBLOX_URL)
	// Mutable secret state — private and only touched while mu is held. External
	// consumers must read it through the lock-guarded accessors (LLMCreds,
	// ActiveKey, ActiveLabel, IsUnlocked, Snapshot) so a lock/unlock/set mutation
	// can't race a read (data-race fix).
	unlocked bool
	tenants  []Tenant
	active   *string
	groq     string
	axur     string
	llmBase  string
	llmModel string
	key      *fernet.Key // derived Fernet key
	salt     string      // std-b64 salt (as stored)
	// ver is the vault-file version v.key was derived under, and therefore the
	// only correct value for the next save()'s envelope. It travels WITH the key
	// — every site that assigns one assigns the other in the same statement, and
	// every rollback restores both — because writing a version the in-memory key
	// does not match produces a file nothing can ever open.
	ver int
	// writeAllowed holds the identities explicitly opted in to being written to
	// (see writelock.go). Empty means nothing is writable, which is the default.
	writeAllowed []string

	// onAuthReset is the coordinated auth reset the server registers once at
	// startup (main): clear the portal Bearer override, reset account.Manager
	// active state, and Rotate() the shared cache. It runs after a vault-tenant
	// mutation whose save() succeeded, so a switched-in portal account or stale
	// cache row can never outlive the tenant change. Set once via SetAuthReset,
	// never mutated after, so lock-free reads are safe.
	onAuthReset func()
}

// SetAuthReset registers the coordinated auth reset (see onAuthReset). Called
// once at wiring time in main; never during request handling.
func (v *Vault) SetAuthReset(fn func()) { v.onAuthReset = fn }

// rotateAuth runs the coordinated auth reset if one is registered. The callback
// touches the auth slot, account.Manager, and cache — never the vault — so it is
// safe to call whether or not v.mu is held (no re-entry, no lock inversion).
func (v *Vault) rotateAuth() {
	if v.onAuthReset != nil {
		v.onAuthReset()
	}
}

// vaultSnap is a full copy of the mutable vault state, taken before a mutation
// so a failed save() can be rolled back (save serializes current in-memory
// fields, so the mutation must happen before save — hence snapshot+restore).
type vaultSnap struct {
	tenants      []Tenant
	active       *string
	groq         string
	axur         string
	llmBase      string
	llmModel     string
	writeAllowed []string
}

// snapshot captures the current mutable state (caller holds v.mu).
func (v *Vault) snapshot() vaultSnap {
	t := make([]Tenant, len(v.tenants))
	copy(t, v.tenants)
	var a *string
	if v.active != nil {
		s := *v.active
		a = &s
	}
	w := make([]string, len(v.writeAllowed))
	copy(w, v.writeAllowed)
	return vaultSnap{tenants: t, active: a, groq: v.groq, axur: v.axur, llmBase: v.llmBase, llmModel: v.llmModel, writeAllowed: w}
}

// restore rolls the mutable state back to a snapshot (caller holds v.mu).
func (v *Vault) restore(s vaultSnap) {
	v.tenants = s.tenants
	v.active = s.active
	v.groq = s.groq
	v.axur = s.axur
	v.llmBase = s.llmBase
	v.llmModel = s.llmModel
	v.writeAllowed = s.writeAllowed
}

// LLMCreds returns a lock-guarded snapshot of the stored LLM credentials (Groq
// key, base URL, model). Callers outside the package MUST read the LLM config
// through this — never the private fields — so a concurrent unlock/lock/set
// can't race the read.
func (v *Vault) LLMCreds() (groq, base, model string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.groq, v.llmBase, v.llmModel
}

// AxurKey returns the stored Axur credential, lock-guarded for the same reason
// LLMCreds is. Empty means one of two different things and the caller MUST NOT
// collapse them: either no key was ever stored, or the vault is locked and this
// one is out of memory. Ask IsUnlocked to tell them apart —
// dashboard.FetchAxurTickets does, and says "vault locked" rather than the
// flatly untrue "not configured".
//
// The value comes back exactly as stored. Turning it into an Authorization
// header is config.AxurAuth's job, done at the point of use, so this path and
// the AXUR_API_KEY path cannot drift into two different rules.
func (v *Vault) AxurKey() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.axur
}

// IsUnlocked reports whether the vault is currently unlocked (lock-guarded).
func (v *Vault) IsUnlocked() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.unlocked
}

// TenantCount reports how many stored connections a successful Unlock found. It
// exists so `vault-passphrase check` can say what it opened rather than only
// that it opened: "unlocked" alone does not distinguish the real vault from an
// empty one, and an empty one is what a wrongly-created vault looks like.
//
// Zero on a locked vault, because a locked vault holds no answer to give.
func (v *Vault) TenantCount() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return 0
	}
	return len(v.tenants)
}

// ResolveFile ports _resolve_vault_file (server.py:2404). It tries VAULT_DIR
// (default "/vault") then dir (the binary's directory), returning the first
// writable location's vault.json. New for laptops (plan 1a): when neither is
// writable it falls back to <UserConfigDir>/bloxsmith/vault.json — a binary's
// cwd is not a durable state dir. Container keeps /vault so the noc-vault
// volume carries over unchanged.
func ResolveFile(vaultDir, dir string) string {
	for _, d := range []string{vaultDir, dir} {
		if d == "" {
			continue
		}
		if writable(d) {
			return filepath.Join(d, "vault.json")
		}
	}
	if ucd, err := os.UserConfigDir(); err == nil {
		d := filepath.Join(ucd, "bloxsmith")
		if writable(d) {
			return filepath.Join(d, "vault.json")
		}
	}
	return filepath.Join(dir, "vault.json")
}

func writable(d string) bool {
	if err := os.MkdirAll(d, 0o755); err != nil {
		return false
	}
	t := filepath.Join(d, ".wtest")
	if err := os.WriteFile(t, nil, 0o600); err != nil {
		return false
	}
	_ = os.Remove(t)
	return true
}

// New creates a Vault bound to path (locked, empty).
func New(path string) *Vault { return &Vault{path: path} }

// Path returns the vault file path.
func (v *Vault) Path() string { return v.path }

// Exists reports whether the vault file is on disk (server.py:2753).
func (v *Vault) Exists() bool {
	_, err := os.Stat(v.path)
	return err == nil
}

// deriveKey ports _derive_key (server.py:2768). It runs scrypt with the
// parameters ver names, then wraps the result as a Fernet key via
// urlsafe-base64 (exactly what Python feeds Fernet).
//
// ver is always the version of the FILE being opened or written — never a
// default — so a v1 file is derived with v1's parameters however old it is.
func deriveKey(passphrase string, salt []byte, ver int) (*fernet.Key, error) {
	p, ok := kdfByVersion[ver]
	if !ok {
		return nil, fmt.Errorf("vault file version %d is newer than this build understands; upgrade bloxsmith", ver)
	}
	dk, err := scrypt.Key([]byte(passphrase), salt, p.N, p.R, p.P, p.KeyLen)
	if err != nil {
		return nil, err
	}
	// base64.urlsafe_b64encode(dk) — the string Python passes to Fernet(...).
	keyStr := base64.URLEncoding.EncodeToString(dk)
	return fernet.DecodeKey(keyStr)
}

// Init creates a new vault with a fresh random salt (server.py:2798 vault_init).
func (v *Vault) Init(passphrase string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.Exists() {
		return errors.New("vault already exists — unlock instead")
	}
	if len(passphrase) < 8 {
		return errors.New("passphrase must be at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	key, err := deriveKey(passphrase, salt, currentVaultVersion)
	if err != nil {
		return err
	}
	v.unlocked = true
	v.tenants = nil
	v.active = nil
	v.groq, v.axur, v.llmBase, v.llmModel = "", "", "", ""
	v.key, v.ver = key, currentVaultVersion
	v.salt = base64.StdEncoding.EncodeToString(salt)
	return v.save()
}

// Unlock decrypts an existing vault with the passphrase (server.py:2810).
// A wrong passphrase (or tampered file) returns ErrWrongPassphrase.
var ErrWrongPassphrase = errors.New("wrong passphrase")

// Unlock reads vault.json, derives the key under the parameters that FILE was
// sealed with, decrypts, and only then upgrades an older file in place.
//
// THE ORDER OF THE STEPS BELOW IS THE SAFETY PROPERTY, not house style:
//
//  1. An unknown version is refused BEFORE any scrypt work. A v2 derive costs
//     ~128 MiB and hundreds of milliseconds; spending that on a file this build
//     has already established it cannot open turns a bad file (or a hostile one)
//     into a memory spike.
//  2. Nothing touches v's state until the payload has decrypted AND parsed. A
//     half-populated vault left behind by a failed unlock would be a locked
//     vault holding a live key.
//  3. The migration runs LAST, on a vault that is already fully open and
//     correct, so it can only ever fail forward: see migrateLocked.
func (v *Vault) Unlock(passphrase string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.Exists() {
		return errors.New("no vault yet")
	}
	b, err := os.ReadFile(v.path)
	if err != nil {
		return err
	}
	var env fileEnvelope
	if err := json.Unmarshal(b, &env); err != nil {
		return err
	}
	// (1) Unknown version: refuse now, before scrypt. Deliberately NOT
	// ErrWrongPassphrase — the passphrase was never tested and telling an
	// operator theirs is wrong would send them to rotate a secret that is fine.
	if _, ok := kdfByVersion[env.V]; !ok {
		return fmt.Errorf("vault file version %d is newer than this build understands; upgrade bloxsmith", env.V)
	}
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil {
		return err
	}
	key, err := deriveKey(passphrase, salt, env.V)
	if err != nil {
		return err
	}
	// ttl=0: Python's Fernet.decrypt with no ttl performs no expiry check.
	// fernet-go treats ttl<=0 as "no TTL", so old tokens always verify.
	plain := fernet.VerifyAndDecrypt([]byte(env.Data), 0, []*fernet.Key{key})
	if plain == nil {
		return ErrWrongPassphrase
	}
	var p payload
	if err := json.Unmarshal(plain, &p); err != nil {
		return ErrWrongPassphrase
	}
	// (2) Decrypted and parsed — only now does any of this become v's state.
	v.unlocked = true
	v.tenants = p.Tenants
	v.active = p.Active
	v.groq = p.Groq
	v.axur = p.Axur
	v.llmBase = p.LLMBase
	v.llmModel = p.LLMModel
	v.writeAllowed = p.WriteAllowed
	v.key, v.ver = key, env.V
	v.salt = env.Salt
	// (3) The unlock has already succeeded. Whatever the upgrade does or fails
	// to do, this function returns nil from here on.
	if env.V < currentVaultVersion {
		if err := v.migrateLocked(passphrase, salt); err != nil {
			log.Printf("[vault] %s is still on v%d key-derivation parameters: the in-place upgrade to v%d "+
				"could not be written (%v). The vault is open and the file is untouched, so nothing is lost "+
				"and the upgrade will be retried at the next unlock.", v.path, env.V, currentVaultVersion, err)
		}
	}
	return nil
}

// migrateLocked re-seals an already-unlocked vault under currentVaultVersion's
// KDF parameters. The caller holds v.mu, has just populated v from a file of an
// older version, and passes the RAW salt bytes that file carried.
//
// THE SALT IS DELIBERATELY REUSED. It is already 16 bytes of crypto/rand from
// whichever Init created the vault, and it is not a secret — its only job is to
// make the derive unique to this file, which it still does. Minting a new one
// here would buy nothing and would mean a migration that failed halfway had
// changed two things instead of one. Rotate exists for a genuine salt refresh.
//
// A FAILURE HERE IS NOT AN UNLOCK FAILURE. The vault in memory is open, correct
// and sealed under a key that matches what is on disk; save()'s tmp+rename means
// a failed write leaves the original v1 file byte-intact. So the caller logs and
// carries on, and the next unlock tries again.
//
// THE ONE ORDERING THAT MATTERS. v.key and v.ver are assigned together, after
// the new key exists, and restored together if the write fails. save() takes the
// envelope's version from v.ver and encrypts with v.key: if those two ever
// disagree — a `V: 2` envelope holding a token sealed with the v1 key — the file
// is unopenable by this build or any other, with no recovery and no passphrase
// to blame. Mirrors Rotate's rollback for the same reason.
func (v *Vault) migrateLocked(passphrase string, salt []byte) error {
	newKey, err := deriveKey(passphrase, salt, currentVaultVersion)
	if err != nil {
		return err
	}
	oldKey, oldVer := v.key, v.ver
	v.key, v.ver = newKey, currentVaultVersion
	if err := v.save(); err != nil {
		v.key, v.ver = oldKey, oldVer
		return err
	}
	return nil
}

// save writes the encrypted vault atomically with 0600 perms (server.py:2772
// _vault_save: Fernet-encrypt payload, tmp+rename, chmod 600).
func (v *Vault) save() error {
	if v.key == nil {
		return errors.New("vault locked")
	}
	// A version this build cannot derive is a version it must not write: the
	// resulting file would be refused by its own Unlock forever. Unreachable
	// today (every site that sets v.key sets v.ver in the same statement) and
	// kept anyway, because the cost of being wrong is an unopenable vault and
	// the cost of the check is a map lookup. Failing here is safe — the write
	// has not started, so vault.json is whatever it already was.
	if _, ok := kdfByVersion[v.ver]; !ok {
		return fmt.Errorf("refusing to write vault file version %d: this build has no key-derivation "+
			"parameters for it, so the file it produced could never be unlocked", v.ver)
	}
	p := payload{
		Tenants:      v.tenants,
		Active:       v.active,
		Groq:         v.groq,
		Axur:         v.axur,
		LLMBase:      v.llmBase,
		LLMModel:     v.llmModel,
		WriteAllowed: v.writeAllowed,
	}
	plain, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tok, err := fernet.EncryptAndSign(plain, v.key)
	if err != nil {
		return err
	}
	// V comes from v.ver — the version v.key was actually derived under. Never a
	// literal: a hardcoded version is how the envelope and the token drift apart.
	env := fileEnvelope{V: v.ver, Salt: v.salt, Data: string(tok)}
	out, err := json.Marshal(env)
	if err != nil {
		return err
	}
	tmp := v.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, v.path); err != nil {
		return err
	}
	_ = os.Chmod(v.path, 0o600)
	return nil
}

// Save persists the current state (public, mutex-guarded).
func (v *Vault) Save() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.save()
}

// Rotate re-encrypts the vault under a NEW passphrase and a freshly random salt,
// then writes it atomically via the same save() every other mutation uses — so a
// rotate can never diverge from the on-disk format Unlock expects.
//
// Requires an UNLOCKED vault: the payload being re-encrypted is whatever is
// already in memory, not a re-read from disk, so there is exactly one lock/write
// cycle rather than an unlock-then-rotate race with itself.
//
// If save() fails, the in-memory key and salt are put back exactly as they were.
// Without that, a failed write would leave the live Vault instance believing it
// holds the NEW key while vault.json on disk is still (or partially) encrypted
// under the OLD one — the next in-process save would then seal the file with a
// key nothing on disk, or in the keychain, actually matches.
func (v *Vault) Rotate(newPassphrase string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return errors.New("vault locked — unlock with the current passphrase before rotating")
	}
	// Same floor as Init: a rotate that accepted a weaker passphrase than a fresh
	// vault would let an operator downgrade their own protection without any of
	// the friction that would flag it.
	if len(newPassphrase) < 8 {
		return errors.New("passphrase must be at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	key, err := deriveKey(newPassphrase, salt, currentVaultVersion)
	if err != nil {
		return err
	}
	// A rotate is also the moment a legacy vault stops being one: it is already
	// re-deriving and re-writing everything, so it emits currentVaultVersion.
	oldKey, oldSalt, oldVer := v.key, v.salt, v.ver
	v.key, v.ver = key, currentVaultVersion
	v.salt = base64.StdEncoding.EncodeToString(salt)
	if err := v.save(); err != nil {
		v.key, v.salt, v.ver = oldKey, oldSalt, oldVer
		return err
	}
	return nil
}

// Lock clears secrets from memory (server.py:2943 vault_lock).
func (v *Vault) Lock() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.lockLocked()
}

// lockLocked is the body of Lock with the mutex already held by the caller.
// Split out so Reset can reuse the exact clearing Lock performs instead of
// keeping a hand-copied field list beside it — a duplicate list is what drifts
// when a new secret field is added and only one of the two sites is updated.
func (v *Vault) lockLocked() {
	v.unlocked = false
	v.tenants = nil
	v.active = nil
	v.groq = ""
	// A stored secret like groq above, so it is cleared for the same reason: a
	// locked vault must not keep answering with a credential out of memory.
	// dashboard.FetchAxurTickets tells this state apart from "no key configured"
	// by asking the vault whether it is unlocked, so a lock reads as "locked",
	// never as "you never set one".
	v.axur = ""
	// Cleared with the rest of the decrypted state: a locked vault must not be
	// able to answer "is this tenant writable" from memory. WriteAllowed()
	// therefore says no while locked, which is the right answer — nothing is
	// writable when nothing is unlocked.
	v.writeAllowed = nil
	v.key = nil
}

// Reset deletes the vault file and returns to first-run state
// (server.py:2951 vault_reset — forgot-passphrase escape hatch).
func (v *Vault) Reset() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	var removeErr error
	if v.Exists() {
		removeErr = os.Remove(v.path)
	}
	// The in-memory wipe runs even when the unlink failed (finding C2-F1).
	// Reset used to return early on a remove error, which left the vault
	// UNLOCKED with every tenant API key, the Groq key and the derived Fernet
	// key still live in the process: the operator asked to wipe, was shown an
	// error, and those secrets kept signing outbound requests until restart.
	// "The file is still there" and "the secrets are still in RAM" are two
	// separate exposures — failing the first is no reason to skip the second,
	// and clearing memory is what the operator actually asked for.
	//
	// Honest scope: this drops the process's copy only. The vault file remains
	// on disk and remains decryptable by anyone with the passphrase, so the
	// remove error is returned unswallowed — the operator still has to delete
	// that file by hand.
	v.lockLocked()
	// Beyond what Lock clears: the LLM endpoint config is not a credential, but
	// Reset means first-run state, and the salt must go so a stale salt cannot
	// be paired with a re-initialised vault. The file version goes with it — it
	// describes the salt/key pair that no longer exists, and a leftover value
	// would be the one thing about the deleted vault that survived into the next
	// one. Init sets both again from scratch.
	v.llmBase, v.llmModel = "", ""
	v.salt = ""
	v.ver = 0
	return removeErr
}

// ActiveKey returns the API key of the active tenant, else "" (server.py:2786).
func (v *Vault) ActiveKey() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.active == nil {
		return ""
	}
	for _, t := range v.tenants {
		if t.ID == *v.active {
			return t.Key
		}
	}
	return ""
}

// ActiveLabel returns the portal label of the active tenant, else "" — feeds
// /api/whoami's "tenant" field (server.py:5095-5100).
func (v *Vault) ActiveLabel() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.active == nil {
		return ""
	}
	for _, t := range v.tenants {
		if t.ID == *v.active {
			return t.Label
		}
	}
	return ""
}

// readPassphraseFile reads a VAULT_PASSPHRASE_FILE, returning ("", nil) when no
// path is configured and ("", err) when a configured path could not be read.
//
// It exists so the read happens ONCE and its error survives. There used to be
// two readers, each doing its own os.ReadFile and discarding the error — one to
// get the value, ResolvePassphrase again to decide the source label — which is
// how a path that could not be read became indistinguishable from no path at
// all. ResolvePassphrase is now the only caller; the other reader was
// PassphraseFromEnv, which has since been removed.
func readPassphraseFile(passphraseFile string) (string, error) {
	p := strings.TrimSpace(passphraseFile)
	if p == "" {
		return "", nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// NO PassphraseFromEnv. It ported _vault_passphrase_from_env (server.py:2756)
// and swallowed the read error, which is the shape the Python original had.
// ResolvePassphrase is the function that REPORTS, and once it stopped going
// through here (see readPassphraseFile) nothing called this at all — it sat
// exported, unreachable, with a test whose own comment said it was not called
// anywhere in this repo. An exported helper that silently discards the reason a
// passphrase file could not be read is a trap for whoever calls it next; use
// ResolvePassphrase.

// PassphraseSource says where an auto-unlock passphrase came from. It exists so
// the startup log can name it: "unlocked" alone tells an operator nothing about
// whether the secret they think they removed is still being used.
type PassphraseSource string

const (
	FromNowhere  PassphraseSource = "none"
	FromEnv      PassphraseSource = "VAULT_PASSPHRASE"
	FromFile     PassphraseSource = "VAULT_PASSPHRASE_FILE"
	FromKeychain PassphraseSource = "macOS keychain"
)

// ResolvePassphrase picks the auto-unlock passphrase and reports which source won,
// plus a warning to log when the answer is one an operator would not expect.
//
// PRECEDENCE: VAULT_PASSPHRASE_FILE, then VAULT_PASSPHRASE, then the keychain.
// Explicit configuration beats the implicit store, because an operator who sets
// the env var means it — and silently preferring the keychain would make a
// deliberate override look like it had been ignored.
//
// THE WARNING IS THE POINT. That precedence has an obvious trap: store the
// passphrase in the keychain, forget to delete the old `.env`, and the `.env` keeps
// winning while the operator believes the secret has moved off disk. They would
// then be strictly worse off than before — same plaintext file, plus a false sense
// that it is gone. So when BOTH exist, this says so, names the file that is still
// being used, and says the keychain entry is being ignored.
func ResolvePassphrase(vaultPath, passphrase, passphraseFile string) (pass string, src PassphraseSource, warn string) {
	fileVal, fileErr := readPassphraseFile(passphraseFile)

	// A CONFIGURED PATH THAT COULD NOT BE READ IS NOT AN ABSENCE.
	//
	// .env.example tells the operator to PREFER this form ("prefer the *_FILE form
	// (Docker/K8s secret) over the raw env var"), and the stock docker-compose file
	// mounts nothing at the /run/secrets path it suggests. Before this warning, that
	// produced pass="", src="none", warn="" — byte-identical to setting nothing at
	// all — so a vault that never auto-unlocked gave no reason anywhere: not in the
	// startup log, not in `vault-passphrase status`.
	//
	// It is a WARNING and not a refusal. A missing auto-unlock file is not a reason
	// to refuse to boot; the browser unlock still works, and failing to start would
	// turn a convenience gap into an outage.
	fileWarn := ""
	switch {
	case fileErr != nil:
		fileWarn = "VAULT_PASSPHRASE_FILE is set to " + strings.TrimSpace(passphraseFile) +
			" but that file could not be read (" + fileErr.Error() + "), so it supplied no passphrase. " +
			"On a docker-compose deploy, check that something actually mounts it into the container."
	case strings.TrimSpace(passphraseFile) != "" && fileVal == "":
		// Readable and empty. Same class, different cause — a secret mounted before
		// it was populated, or a truncated write. It used to SHADOW
		// VAULT_PASSPHRASE silently (the old code took the empty read as the
		// answer), which is the worse of the two possible behaviours: the operator
		// had a working passphrase set and it stopped being used with nothing said.
		// It now falls through to VAULT_PASSPHRASE and says why.
		fileWarn = "VAULT_PASSPHRASE_FILE is set to " + strings.TrimSpace(passphraseFile) +
			" but that file is empty, so it supplied no passphrase."
	}

	env := fileVal
	envSrc := FromFile
	if env == "" {
		env, envSrc = passphrase, FromEnv
	}

	kc := ""
	kcErr := error(nil)
	if KeychainSupported() {
		kc, kcErr = GetKeychainPassphrase(vaultPath)
	}

	// join puts the unreadable-file warning FIRST when there is one. It is the thing
	// the operator got wrong; the rest is advice about the source that won instead.
	join := func(rest string) string {
		switch {
		case fileWarn == "":
			return rest
		case rest == "":
			return fileWarn
		default:
			return fileWarn + " " + rest
		}
	}

	switch {
	case env != "" && kc != "":
		return env, envSrc, join("a vault passphrase is stored in the macOS keychain AND supplied via " +
			string(envSrc) + ". The " + string(envSrc) + " value is the one being used and the keychain entry is " +
			"being ignored. Remove the " + string(envSrc) + " value to actually get the passphrase off disk.")
	case env != "":
		if KeychainSupported() {
			return env, envSrc, join("the vault passphrase is coming from " + string(envSrc) + ", which means it is " +
				"stored in plaintext on this machine. `bloxsmith vault-passphrase set` moves it into the macOS " +
				"keychain so it no longer travels with a disk image or a backup.")
		}
		return env, envSrc, join("")
	case kc != "":
		return kc, FromKeychain, join("")
	default:
		// No passphrase at all is the normal no-auto-unlock case, not a fault. But a
		// keychain lookup that FAILED (as opposed to finding nothing) must be said
		// out loud, or a vault that could have unlocked stays locked with no reason
		// given.
		if kcErr != nil && !errors.Is(kcErr, ErrNoKeychainEntry) && !errors.Is(kcErr, ErrUnsupported) {
			return "", FromNowhere, join("the macOS keychain could not be read, so a stored vault passphrase " +
				"(if any) could not be used: " + kcErr.Error())
		}
		return "", FromNowhere, join("")
	}
}

// AutoUnlock replicates the entry-point flow (server.py:6538-6553): if a
// passphrase is available from the environment, unlock an existing vault or
// create a new one. Returns (created, error).
func (v *Vault) AutoUnlock(passphrase string) (created bool, err error) {
	if passphrase == "" {
		return false, nil
	}
	if v.Exists() {
		return false, v.Unlock(passphrase)
	}
	return true, v.Init(passphrase)
}
