# Step 1: take the next free address in the demo subnet and reserve it in the same call.
variable "change"    { type = string }
variable "space_id"  { type = string }
variable "subnet_id" { type = string }
resource "bloxone_ipam_address" "server" {
  next_available_id = var.subnet_id
  space             = var.space_id
  names             = [{ name = "niosx-${var.change}", type = "user" }]
  tags              = { bloxsmith_change = var.change }
}
output "ip" { value = bloxone_ipam_address.server.address }
