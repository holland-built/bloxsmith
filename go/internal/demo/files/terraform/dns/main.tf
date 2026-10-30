# Steps 3-6: start DNS on the new NIOS-X host, put it in a name server group,
# and have that group serve a demo zone with records for the server and the Proxmox host.
variable "change"   { type = string }
variable "ip"       { type = string }
variable "pve_ip"   { type = string }  # the Proxmox host, so the demo can resolve it by name
variable "pve_name" { type = string }  # its short name, e.g. lab

data "bloxone_infra_hosts" "server" {
  filters = { ip_address = var.ip }
}
locals { host = one(data.bloxone_infra_hosts.server.results) }

resource "bloxone_infra_service" "dns" {
  name           = "dns-${var.change}"
  pool_id        = local.host.pool_id
  service_type   = "dns"
  desired_state  = "start"
  wait_for_state = true
  tags           = { bloxsmith_change = var.change }
}

data "bloxone_dns_hosts" "server" {
  filters    = { address = var.ip }
  retry_if_not_found = true
  depends_on = [bloxone_infra_service.dns]
}

resource "bloxone_dns_auth_nsg" "demo" {
  name                 = "bloxsmith-${var.change}"
  comment              = "Bloxsmith demo name server group"
  internal_secondaries = [{ host = one(data.bloxone_dns_hosts.server.results).id }]
  tags                 = { bloxsmith_change = var.change }
}

data "bloxone_dns_views" "default" {
  filters = { name = "default" }
}

resource "bloxone_dns_auth_zone" "demo" {
  fqdn         = "demo-${var.change}.example."
  primary_type = "cloud"
  view         = one(data.bloxone_dns_views.default.results).id
  nsgs         = [bloxone_dns_auth_nsg.demo.id]
  comment      = "Bloxsmith demo zone"
  tags         = { bloxsmith_change = var.change }
}

resource "bloxone_dns_a_record" "server" {
  zone        = bloxone_dns_auth_zone.demo.id
  name_in_zone = "niosx"
  rdata       = { address = var.ip }
  tags        = { bloxsmith_change = var.change }
}

resource "bloxone_dns_a_record" "pve" {
  zone        = bloxone_dns_auth_zone.demo.id
  name_in_zone = var.pve_name
  rdata       = { address = var.pve_ip }
  tags        = { bloxsmith_change = var.change }
}

output "zone" { value = bloxone_dns_auth_zone.demo.fqdn }
