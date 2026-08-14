# uddi_self_service_example

Self-service portal example for Infoblox Universal DDI. Demonstrates how to:

- Allocate the **next available subnet** from an address block found by tag
- **Provision** a subnet plus forward/reverse DNS zones in one command
- Create and modify **authoritative DNS zones** and **resource records**
- Allocate and release **IP addresses**
- **View** available IP spaces, DNS views, and address blocks
- Output results as **text, JSON, or table** for scripting and reporting

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
pytest
```

## Credentials

Copy the example and add your API key:

```bash
cp uddi.ini.example uddi.ini
```

```ini
[UDDI]
api_key  = your-api-key-here
# base_url = https://csp.infoblox.com
# valid_cert = true
```

Credentials are resolved in this order (highest priority first):

1. `--api-key` CLI flag
2. `INFOBLOX_PORTAL_KEY` or `UDDI_API_KEY` environment variable
3. `uddi.ini` credentials file (default path, override with `-i`)

## Usage

```bash
uddi-self-service --help
# or
python run_portal.py --help
```

### Output formats

All subcommands accept `-o / --output`:

```bash
uddi-self-service -o json list-views
uddi-self-service -o table list-address-blocks
uddi-self-service -o text create-subnet ...   # default
```

`json` output is ideal for scripting — capture the resource ID of a new subnet:

```bash
SUBNET_ID=$(uddi-self-service -o json create-subnet \
  --tag-key environment --tag-value prod --cidr 24 | jq -r '.subnets[0].id')
```

---

### View — find resource IDs before operating

List IP spaces:

```bash
uddi-self-service list-spaces
uddi-self-service list-spaces --name corp
```

List DNS views:

```bash
uddi-self-service list-views
uddi-self-service list-views --tag-key owner --tag-value infra
```

List address blocks:

```bash
uddi-self-service list-address-blocks
uddi-self-service list-address-blocks --tag-key environment --tag-value prod
uddi-self-service list-address-blocks --space "ipam/ip_space/abc123"
```

Find subnets or address blocks by tag:

```bash
uddi-self-service find-networks --tag-key environment --tag-value prod
uddi-self-service find-networks --tag-key environment --tag-value prod --type address_block
```

---

### Provision — one-shot subnet + DNS setup

Allocate a /24 from an address block tagged `environment=prod`, create a
forward zone, and auto-derive the in-addr.arpa reverse zone:

```bash
uddi-self-service provision \
  --tag-key environment --tag-value prod \
  --cidr 24 \
  --name "new-prod-subnet" \
  --forward-zone prod.example.com \
  --view "dns/view/xyz789" \
  --reverse-zone \
  --comment "Provisioned by self-service portal"
```

Subnet only (no DNS):

```bash
uddi-self-service provision \
  --tag-key environment --tag-value prod \
  --cidr 24
```

---

### Create operations

**Next available subnet** from an address block found by tag:

```bash
uddi-self-service create-subnet \
  --tag-key environment --tag-value prod \
  --cidr 24 --name "new-prod-subnet"
```

**DNS zone:**

```bash
uddi-self-service create-zone \
  --fqdn example.internal \
  --view "dns/view/xyz789" \
  --tag owner=infra-team
```

**DNS record:**

```bash
uddi-self-service create-record \
  --name www --zone "dns/auth_zone/zone123" \
  --type A --rdata 192.0.2.10 \
  --view "dns/view/xyz789" --ttl 300
```

Supported record types: A, AAAA, CNAME, PTR, MX, TXT, SRV.

**Next available IP** from a subnet found by tag:

```bash
uddi-self-service allocate-ip --tag-key role --tag-value web --count 3
```

---

### Modify operations

```bash
uddi-self-service modify-subnet --id "ipam/subnet/abc" --name new-name --comment "updated"
uddi-self-service modify-zone   --id "dns/auth_zone/xyz" --disable
uddi-self-service modify-record --id "dns/record/rec1"  --rdata 192.0.2.99 --ttl 600
```

`--tag KEY=VALUE` (repeatable) replaces the entire tag set on a modify call. Omit it to leave tags unchanged.

---

### Delete / release operations

All delete subcommands prompt for confirmation unless `-y / --yes` is supplied:

```bash
uddi-self-service delete-subnet --id "ipam/subnet/abc" --yes
uddi-self-service delete-zone   --id "dns/auth_zone/xyz"
uddi-self-service delete-record --id "dns/record/rec1"
uddi-self-service release-ip    --id "ipam/address/ip1" --yes
```

---

## Common options

| Option | Description |
|--------|-------------|
| `-i FILE` | Path to ini credentials file (default: `uddi.ini`) |
| `-k KEY`  | API key (overrides ini file and environment) |
| `-o FORMAT` | Output format: `text` (default), `json`, `table` |
| `-d`      | Enable debug logging |

---

## Development with Claude Code

This project was developed with the assistance of [Claude Code](https://claude.ai/claude-code), Anthropic's agentic coding tool.

Claude Code was used to:

- Design and implement the Flask web portal and HTMX-driven UI
- Build the drilldown navigation hierarchy (IP spaces → subnets → addresses; DNS views → zones → records)
- Add inline edit and delete actions to all data panels
- Refactor the interface from a tab-based layout to a collapsible sidebar
- Write and maintain unit tests

> **Note:** All generated code was reviewed and tested before use. AI-assisted development does not replace human oversight — review any AI-generated changes carefully before committing or deploying.

---

## Project layout

```
uddi_self_service_example/
├── run_portal.py                  # Convenience runner script
├── src/
│   └── uddi_self_service_example/
│       ├── __init__.py
│       ├── __main__.py            # CLI entry point (argparse subcommands)
│       ├── client.py              # PortalClient wrapping universal-ddi-python-client
│       ├── config.py              # Credential loading (ini / env / CLI)
│       ├── output.py              # PortalResult, Formatter (text/json/table)
│       └── portal.py             # Self-service operations
├── tests/
│   └── test_portal.py
├── pyproject.toml
└── uddi.ini.example
```
