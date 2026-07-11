"""Evidence-pack export -- one JSON document, admin-gated. Not a zip/PDF
generator; "one-click" means one endpoint returning the full audit trail
plus its computed integrity-chain status."""

from fastapi import APIRouter, Depends

from backend.audit import log as audit_log
from backend.auth.roles import Role, require_role

router = APIRouter()


@router.get("/api/audit/export")
def export_audit(_session: dict = Depends(require_role(Role.admin))):
    chain = audit_log.verify_chain()
    return {"entries": audit_log.read_all(), "chain_valid": chain["valid"], "broken_index": chain["broken_index"]}
