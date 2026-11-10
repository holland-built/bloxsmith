// "Copy as Ansible playbook" on the Automate page. Each playbook does the same
// job as Build, written for Infoblox's own infoblox.universal_ddi collection.
//
// Only jobs checked against that collection's module source get one
// (github.com/infobloxopen/universal-ddi-ansible, plugins/modules, read
// 2026-11-04): ipam_address and ipam_subnet take next_available_id, and
// dns_record takes rdata keyed address, cname or text. Set up a branch office
// and Get a demo ready have no playbook: they are many steps plus Terraform.

const q = (v) => JSON.stringify(String(v ?? '')) // a JSON string is a valid YAML string

const HEADER = [
  '# Made by Bloxsmith. Needs the Infoblox collection:',
  '#   ansible-galaxy collection install infoblox.universal_ddi',
  '# Set INFOBLOX_PORTAL_KEY to your API key before running. INFOBLOX_PORTAL_URL',
  '# defaults to https://csp.infoblox.com.',
]

const RDATA_KEY = { A: 'address', AAAA: 'address', CNAME: 'cname', TXT: 'text' }

// playbookFor returns the playbook text, or '' for a job without one.
export function playbookFor(job, input) {
  let title
  let task
  switch (job) {
    case 'ip':
      title = input.name ? `Get an IP address for ${input.name}` : 'Get an IP address'
      task = [
        '    # Each run reserves another address.',
        '    - name: Reserve the next free address in the network',
        '      infoblox.universal_ddi.ipam_address:',
        `        space: ${q(input.space)}`,
        `        next_available_id: ${q(input.subnet_id)}`,
        ...(input.name ? [`        comment: ${q(input.name)}`] : []),
        '        state: present',
      ]
      break
    case 'dns': {
      const key = Object.hasOwn(RDATA_KEY, input.type) ? RDATA_KEY[input.type] : null
      if (!key) return ''
      title = `Add the DNS name ${input.name_in_zone}`
      task = [
        `    - name: ${q(`Add a ${input.type} record`)}`,
        '      infoblox.universal_ddi.dns_record:',
        `        zone: ${q(input.zone_id)}`,
        `        name_in_zone: ${q(input.name_in_zone === '@' ? '' : input.name_in_zone)}`,
        `        type: ${q(input.type)}`,
        '        rdata:',
        `          ${key}: ${q(input.value)}`,
        '        state: present',
      ]
      break
    }
    case 'network': {
      const cidr = Number(input.cidr)
      if (!Number.isInteger(cidr) || cidr < 8 || cidr > 30) return ''
      title = input.name ? `Make the network ${input.name}` : 'Make a new network'
      task = [
        '    # Each run makes another network.',
        `    - name: ${q(`Make the next free /${cidr} in the address block`)}`,
        '      infoblox.universal_ddi.ipam_subnet:',
        `        space: ${q(input.space)}`,
        `        next_available_id: ${q(input.block_id)}`,
        `        cidr: ${cidr}`,
        ...(input.name ? [`        name: ${q(input.name)}`, '        tags:', `          Name: ${q(input.name)}`] : []),
        '        state: present',
      ]
      break
    }
    default:
      return ''
  }
  return [
    ...HEADER,
    `- name: ${q(title)}`,
    '  hosts: localhost',
    '  gather_facts: false',
    '  tasks:',
    ...task,
    '',
  ].join('\n')
}
