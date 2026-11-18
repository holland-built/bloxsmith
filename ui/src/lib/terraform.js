// "Copy as Terraform" on the Automate page, beside the Ansible playbook
// (lib/ansible.js). Each file does the same job as Build, written for
// Infoblox's own Terraform provider, infobloxopen/bloxone. Automate.jsx loads
// this file only once a preview is shown.
//
// Resource and attribute names were checked against the provider's docs
// (github.com/infobloxopen/terraform-provider-bloxone, docs/resources, read
// 2026-11-17) and a colleague's working code (blox42-terraform): ipam_address
// and ipam_subnet take next_available_id, and each record type is its own
// resource whose rdata is keyed address, cname or text. Jobs with no clean
// single resource (Set up a branch office, Get a demo ready) get nothing.

// An HCL string: JSON escapes quotes, backslashes and line breaks, and HCL
// also reads ${ and %{ as code, so those are doubled to stay plain text.
const q = (v) => JSON.stringify(String(v ?? '')).replace(/([$%])\{/g, (_, c) => c + c + '{')

const HEADER = [
  '# Made by Bloxsmith. Needs Terraform and Infoblox\'s bloxone provider.',
  '# Set INFOBLOX_PORTAL_KEY to your API key and INFOBLOX_PORTAL_URL to your',
  '# portal (usually https://csp.infoblox.com), then run terraform init and',
  '# terraform apply.',
  'terraform {',
  '  required_providers {',
  '    bloxone = {',
  '      source  = "infobloxopen/bloxone"',
  '      version = ">= 1.6.0"',
  '    }',
  '  }',
  '}',
  '',
  'provider "bloxone" {}',
  '',
]

const RECORD = {
  A: ['bloxone_dns_a_record', 'address'],
  AAAA: ['bloxone_dns_aaaa_record', 'address'],
  CNAME: ['bloxone_dns_cname_record', 'cname'],
  TXT: ['bloxone_dns_txt_record', 'text'],
}

// terraformFor returns the Terraform file text, or '' for a job without one.
export function terraformFor(job, input) {
  let body
  switch (job) {
    case 'ip':
      body = [
        '# Terraform keeps this one address: running apply again does not take another.',
        'resource "bloxone_ipam_address" "this" {',
        `  space             = ${q(input.space)}`,
        `  next_available_id = ${q(input.subnet_id)}`,
        ...(input.name ? [`  comment           = ${q(input.name)}`] : []),
        '}',
      ]
      break
    case 'dns': {
      const rec = Object.hasOwn(RECORD, input.type) ? RECORD[input.type] : null
      if (!rec) return ''
      body = [
        `resource "${rec[0]}" "this" {`,
        `  zone         = ${q(input.zone_id)}`,
        `  name_in_zone = ${q(input.name_in_zone === '@' ? '' : input.name_in_zone)}`,
        '  rdata = {',
        `    ${rec[1]} = ${q(input.value)}`,
        '  }',
        '}',
      ]
      break
    }
    case 'network': {
      const cidr = Number(input.cidr)
      if (!Number.isInteger(cidr) || cidr < 8 || cidr > 30) return ''
      body = [
        `# The next free /${cidr} in the address block. Terraform keeps this one network.`,
        'resource "bloxone_ipam_subnet" "this" {',
        `  space             = ${q(input.space)}`,
        `  next_available_id = ${q(input.block_id)}`,
        `  cidr              = ${cidr}`,
        ...(input.name ? [`  name              = ${q(input.name)}`, '  tags = {', `    Name = ${q(input.name)}`, '  }'] : []),
        '}',
      ]
      break
    }
    default:
      return ''
  }
  return [...HEADER, ...body, ''].join('\n')
}
