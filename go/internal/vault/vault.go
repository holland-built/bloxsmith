// Package vault ports Bloxsmith's encrypted credential store from server.py
// (lines 2404-2416, 2750-3055). It reads and writes the EXACT on-disk format
// the Python app produces so an existing user's vault.json unlocks unchanged.
//
// Crypto parity (server.py:2768-2779):
//   - KDF:    scrypt(passphrase, salt, N=2^15, r=8, p=1, dkLen=32)  [_derive_key]
//     then base64.urlsafe_b64encode(dk) -> the 44-char Fernet key.
//   - cipher: Fernet (AES-128-CBC + HMAC-SHA256, standard token layout).
//   - file:   {"v":1, "salt": <std-b64 of 16 salt bytes>, "data": <fernet token>}
//     at $VAULT_DIR/vault.json; plaintext is the JSON payload
//     {tenants, active, groq, llm_base, llm_model}.
package vault

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	fernet "github.com/fernet/fernet-go"
	"golang.org/x/crypto/scrypt"
)

// scrypt parameters — MUST match server.py:2769 exactly.
const (
	scryptN     = 1 << 15 // 32768
	scryptR     = 8
	scryptP     = 1
	scryptKeyLn = 32
)

// Tenant is one stored connection (server.py:2891 shape).
type Tenant struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Key   string `json:"key"`
}

// payload is the Fernet-encrypted plaintext (server.py:2773-2774 _vault_save).
type payload struct {
	Tenants  []Tenant `json:"tenants"`
	Active   *string  `json:"active"`
	Groq     string   `json:"groq"`
	LLMBase  string   `json:"llm_base"`
	LLMModel string   `json:"llm_model"`
}

// fileEnvelope is the cleartext on-disk wrapper (server.py:2778).
type fileEnvelope struct {
	V    int    `json:"v"`
	Salt string `json:"salt"` // std base64 of the 16 raw salt bytes
	Data string `json:"data"` // Fernet token string
}

// Vault mirrors the server.py _vault dict (2750) plus its file location.
type Vault struct {
	mu       sync.Mutex
	path     string
	BaseURL  string // Infoblox base URL for portal name/key lookups (INFOBLOX_URL)
	// Mutable secret state — private and only touched while mu is held. External
	// consumers must read it through the lock-guarded accessors (LLMCreds,
	// ActiveKey, ActiveLabel, IsUnlocked, Snapshot) so a lock/unlock/set mutation
	// can't race a read (data-race fix).
	unlocked bool
	tenants  []Tenant
	active   *string
	groq     string
	llmBase  string
	llmModel string
	key      *fernet.Key // derived Fernet key
	salt     string      // std-b64 salt (as stored)

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
	tenants  []Tenant
	active   *string
	groq     string
	llmBase  string
	llmModel string
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
	return vaultSnap{tenants: t, active: a, groq: v.groq, llmBase: v.llmBase, llmModel: v.llmModel}
}

// restore rolls the mutable state back to a snapshot (caller holds v.mu).
func (v *Vault) restore(s vaultSnap) {
	v.tenants = s.tenants
	v.active = s.active
	v.groq = s.groq
	v.llmBase = s.llmBase
	v.llmModel = s.llmModel
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

// IsUnlocked reports whether the vault is currently unlocked (lock-guarded).
func (v *Vault) IsUnlocked() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.unlocked
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

// deriveKey ports _derive_key (server.py:2768). It runs scrypt then wraps the
// result as a Fernet key via urlsafe-base64 (exactly what Python feeds Fernet).
func deriveKey(passphrase string, salt []byte) (*fernet.Key, error) {
	dk, err := scrypt.Key([]byte(passphrase), salt, scryptN, scryptR, scryptP, scryptKeyLn)
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
	key, err := deriveKey(passphrase, salt)
	if err != nil {
		return err
	}
	v.unlocked = true
	v.tenants = nil
	v.active = nil
	v.groq, v.llmBase, v.llmModel = "", "", ""
	v.key = key
	v.salt = base64.StdEncoding.EncodeToString(salt)
	return v.save()
}

// Unlock decrypts an existing vault with the passphrase (server.py:2810).
// A wrong passphrase (or tampered file) returns ErrWrongPassphrase.
var ErrWrongPassphrase = errors.New("wrong passphrase")

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
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil {
		return err
	}
	key, err := deriveKey(passphrase, salt)
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
	v.unlocked = true
	v.tenants = p.Tenants
	v.active = p.Active
	v.groq = p.Groq
	v.llmBase = p.LLMBase
	v.llmModel = p.LLMModel
	v.key = key
	v.salt = env.Salt
	return nil
}

// save writes the encrypted vault atomically with 0600 perms (server.py:2772
// _vault_save: Fernet-encrypt payload, tmp+rename, chmod 600).
func (v *Vault) save() error {
	if v.key == nil {
		return errors.New("vault locked")
	}
	p := payload{
		Tenants:  v.tenants,
		Active:   v.active,
		Groq:     v.groq,
		LLMBase:  v.llmBase,
		LLMModel: v.llmModel,
	}
	plain, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tok, err := fernet.EncryptAndSign(plain, v.key)
	if err != nil {
		return err
	}
	env := fileEnvelope{V: 1, Salt: v.salt, Data: string(tok)}
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

// Lock clears secrets from memory (server.py:2943 vault_lock).
func (v *Vault) Lock() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.unlocked = false
	v.tenants = nil
	v.active = nil
	v.groq = ""
	v.key = nil
}

// Reset deletes the vault file and returns to first-run state
// (server.py:2951 vault_reset — forgot-passphrase escape hatch).
func (v *Vault) Reset() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.Exists() {
		if err := os.Remove(v.path); err != nil {
			return err
		}
	}
	v.unlocked = false
	v.tenants = nil
	v.active = nil
	v.groq, v.llmBase, v.llmModel = "", "", ""
	v.key = nil
	v.salt = ""
	return nil
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

// PassphraseFromEnv ports _vault_passphrase_from_env (server.py:2756): prefer a
// mounted VAULT_PASSPHRASE_FILE, else the VAULT_PASSPHRASE env var.
func PassphraseFromEnv(passphrase, passphraseFile string) string {
	if p := strings.TrimSpace(passphraseFile); p != "" {
		if b, err := os.ReadFile(p); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return passphrase
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
