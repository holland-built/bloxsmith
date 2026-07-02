"""Signal extraction from network vertical data (subnets/leases/zones/views).

Derives alert Signals from step-3a's `/api/verticals/network` shape at read
time. No edits to normalize.py/fetch.py/routes_network.py are needed --
`category` is computed here, not stored on the 3a records.
"""

import time
from typing import TypedDict


class Signal(TypedDict):
    source: str
    entity_type: str
    entity_id: str
    category: str
    severity: str
    message: str
    detected_at: float


# Future producers (build_host_signals, build_audit_signals, etc.) append to this same list — do not modify correlate.py or suppression.py when adding a new signal source.
def build_signals(network_data: dict) -> list:
    signals = []

    for subnet in network_data.get("subnets", []):
        if subnet["severity"] != "ok":
            signals.append({
                "source": "network",
                "entity_type": "subnet",
                "entity_id": subnet["id"],
                "category": "subnet-utilization",
                "severity": subnet["severity"],
                "message": f"{subnet['name']} at {subnet['util']}% utilization",
                "detected_at": time.time(),
            })

    for zone in network_data.get("zones", []):
        if zone["severity"] == "warn":
            signals.append({
                "source": "network",
                "entity_type": "zone",
                "entity_id": zone["id"],
                "category": "dns-ttl-anomaly",
                "severity": "warn",
                "message": f"{zone['fqdn']}: {', '.join(zone['issues'])}",
                "detected_at": time.time(),
            })

    for lease in network_data.get("leases", []):
        if lease["severity"] == "warn":
            signals.append({
                "source": "network",
                "entity_type": "lease",
                "entity_id": lease["addr"],
                "category": "dhcp-expired-lease",
                "severity": "warn",
                "message": f"Lease {lease['addr']} ({lease.get('host') or 'unknown host'}) expired",
                "detected_at": time.time(),
            })

    return signals
