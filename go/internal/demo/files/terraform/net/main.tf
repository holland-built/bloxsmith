# The demo network in Infoblox: one IP space and the subnet on the Proxmox demo bridge.
variable "subnet"  { type = string }  # e.g. 10.99.0.0
variable "cidr"    { type = number }  # e.g. 24
variable "gateway" { type = string }  # e.g. 10.99.0.1, on the Proxmox demo bridge

resource "bloxone_ipam_ip_space" "demo" {
  name    = "bloxsmith-demo"
  comment = "Bloxsmith demo network. Safe to delete when no demo is running."
  tags    = { managed_by = "bloxsmith" }
}
resource "bloxone_ipam_subnet" "demo" {
  space   = bloxone_ipam_ip_space.demo.id
  address = var.subnet
  cidr    = var.cidr
  comment = "Bloxsmith demo network. The gateway is the Proxmox demo bridge."
  tags    = { managed_by = "bloxsmith" }
}
# The gateway is the Proxmox bridge; reserve it so next-free never hands it out.
resource "bloxone_ipam_address" "gateway" {
  address = var.gateway
  space   = bloxone_ipam_ip_space.demo.id
  names   = [{ name = "proxmox-demo-gateway", type = "user" }]
  tags    = { managed_by = "bloxsmith" }
  depends_on = [bloxone_ipam_subnet.demo]
}
output "space_id"  { value = bloxone_ipam_ip_space.demo.id }
output "subnet_id" { value = bloxone_ipam_subnet.demo.id }
