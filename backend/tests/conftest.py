"""
Shared pytest fixtures for backend tests.

Every test gets an isolated vault: VAULT_FILE is monkeypatched to a path
inside pytest's per-test tmp_path, and the in-memory `_vault` dict is reset
to its initial locked state before AND after each test so state never
leaks between tests (or into a real vault.json on disk).
"""

import pytest

from backend import vault

_INITIAL_VAULT_STATE = {
    "unlocked": False, "tenants": [], "active": None,
    "groq": "", "llm_base": "", "llm_model": "", "_key": None, "_salt": "",
}


def _reset_vault_state():
    vault._vault.clear()
    vault._vault.update(_INITIAL_VAULT_STATE.copy())
    vault._vault["tenants"] = []


@pytest.fixture(autouse=True)
def isolated_vault(tmp_path, monkeypatch):
    """Point vault.VAULT_FILE at a temp file and reset in-memory state."""
    monkeypatch.setattr(vault, "VAULT_FILE", str(tmp_path / "vault.json"))
    _reset_vault_state()
    yield
    _reset_vault_state()
