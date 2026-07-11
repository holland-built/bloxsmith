"""
Unit + parity tests for backend/vault.py.

The parity test is the most important one here: it independently
re-derives the scrypt key and Fernet-decrypts the on-disk vault.json using
nothing from vault.py's own decrypt path, to prove the on-disk byte format
is truly compatible (a self-canceling bug in vault.py's own encrypt+decrypt
round-trip would NOT be caught by simply calling vault_unlock again).
"""

import base64
import hashlib
import json

from cryptography.fernet import Fernet

from backend import vault


# ── vault_init ──────────────────────────────────────────────────────────

def test_init_short_passphrase_rejected():
    result = vault.vault_init("short1")
    assert result["ok"] is False
    assert "length" in result["error"] or "8 characters" in result["error"] or "least" in result["error"]


def test_init_valid_passphrase_succeeds():
    result = vault.vault_init("longenoughpass")
    assert result == {"ok": True}


def test_init_twice_fails():
    first = vault.vault_init("longenoughpass")
    assert first["ok"] is True
    second = vault.vault_init("longenoughpass")
    assert second["ok"] is False


# ── vault_unlock ────────────────────────────────────────────────────────

def test_unlock_correct_passphrase():
    vault.vault_init("correctpassphrase")
    vault.vault_lock()
    result = vault.vault_unlock("correctpassphrase")
    assert result == {"ok": True}


def test_unlock_wrong_passphrase():
    vault.vault_init("correctpassphrase")
    vault.vault_lock()
    result = vault.vault_unlock("totallywrongpass")
    assert result == {"ok": False, "error": "wrong passphrase"}


# ── tenant CRUD ─────────────────────────────────────────────────────────

def test_add_tenant():
    vault.vault_init("tenantpassphrase")
    result = vault.vault_add_tenant("test-tenant", "Token abc123")
    assert result["ok"] is True
    assert "id" in result
    assert result["label"] == "test-tenant"


def test_remove_tenant():
    vault.vault_init("tenantpassphrase")
    added = vault.vault_add_tenant("test-tenant", "Token abc123")
    tid = added["id"]
    remove_result = vault.vault_remove_tenant(tid)
    assert remove_result["ok"] is True
    status = vault.vault_status()
    assert tid not in [t["id"] for t in status["tenants"]]


def test_set_active_unknown_tenant():
    vault.vault_init("tenantpassphrase")
    result = vault.vault_set_active("does-not-exist")
    assert result["ok"] is False


# ── lock / reset ────────────────────────────────────────────────────────

def test_lock():
    vault.vault_init("lockpassphrase")
    result = vault.vault_lock()
    assert result == {"ok": True}
    status = vault.vault_status()
    # VAULT_MODE governs the "unlocked" field's fallback; check the
    # underlying in-memory flag directly, which always reflects lock state.
    assert vault._vault["unlocked"] is False


def test_reset_removes_file_from_disk():
    vault.vault_init("resetpassphrase")
    assert vault.vault_exists()
    result = vault.vault_reset()
    assert result == {"ok": True}
    assert not vault.vault_exists()


# ── _norm_key table ─────────────────────────────────────────────────────

def test_norm_key_table():
    cases = [
        ('"Token abc"', "Token abc"),
        ("Authorization: Token xyz", "Token xyz"),
        ("bearer sometoken", "Bearer sometoken"),
        ("eyJhbGciOiJIUzI1NiJ9.fake.jwt", "Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt"),
        ("rawkey123", "Token rawkey123"),
    ]
    for raw, expected in cases:
        assert vault._norm_key(raw) == expected, f"input={raw!r}"


# ── on-disk envelope shape ──────────────────────────────────────────────

def test_on_disk_envelope_keys():
    vault.vault_init("envelopepassphrase")
    vault.vault_add_tenant("test-tenant", "Token abc123")
    with open(vault.VAULT_FILE) as f:
        raw = json.load(f)
    assert set(raw.keys()) == {"v", "salt", "data"}


# ── parity test ─────────────────────────────────────────────────────────

def test_parity_independent_scrypt_fernet_roundtrip():
    passphrase = "paritytest123"
    vault.vault_init(passphrase)
    vault.vault_add_tenant("parity-tenant", "Token paritykey")

    with open(vault.VAULT_FILE) as f:
        raw = json.load(f)

    # Independently re-derive the key — NOT via vault._derive_key.
    salt = base64.b64decode(raw["salt"])
    dk = hashlib.scrypt(
        passphrase.encode(), salt=salt, n=2 ** 15, r=8, p=1,
        dklen=32, maxmem=64 * 1024 * 1024,
    )
    independent_key = base64.urlsafe_b64encode(dk)

    # Independently decrypt — NOT via vault.vault_unlock.
    decrypted = Fernet(independent_key).decrypt(raw["data"].encode())
    payload = json.loads(decrypted)

    assert payload["tenants"] == vault._vault["tenants"]
