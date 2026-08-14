#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: portal.py
 Author: Chris Marrison
 Description: Self-service portal operations for Universal DDI

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import ipaddress
import logging
from typing import Optional

from .client import PortalClient
from .output import PortalResult

logger = logging.getLogger(__name__)

_DRY = '[DRY RUN]'

_RDATA_FORMAT_HINTS = {
    'A':    'IPv4 address (e.g. 192.0.2.1)',
    'AAAA': 'IPv6 address (e.g. 2001:db8::1)',
    'CNAME': 'FQDN of canonical name (e.g. host.example.com.)',
    'PTR':  'FQDN of target host (e.g. host.example.com.)',
    'NS':   'name server FQDN (e.g. ns1.example.com.)',
    'DNAME': 'target domain (e.g. example.com.)',
    'TXT':  'text string (e.g. v=spf1 include:example.com ~all)',
    'MX':   'preference exchange (e.g. 10 mail.example.com.)',
    'SRV':  'priority weight port target (e.g. 10 0 443 host.example.com.)',
    'CAA':  'flags tag value (e.g. 0 issue letsencrypt.org)',
}


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------

def _subnet_cidr(subnet) -> str:
    '''Return "address/prefix" string for a Subnet object'''
    addr = getattr(subnet, 'address', '') or ''
    cidr = getattr(subnet, 'cidr', '') or ''
    return f'{addr}/{cidr}' if addr and cidr else str(subnet)


def _obj_to_dict(obj, *fields) -> dict:
    '''Extract named fields from an SDK model object into a plain dict'''
    return {f: getattr(obj, f, None) for f in fields}


def _cidr_to_reverse_zone(address: str, prefix_len: int) -> str:
    '''
    Derive the in-addr.arpa zone name for an IPv4 network.

    Supports /8, /16, and /24 natural boundaries. For other prefix lengths
    the zone is derived from the enclosing /8 boundary, which is the safest
    general fallback (the caller should verify this is suitable).

    Parameters:
        address (str): network address (e.g. "10.0.1.0")
        prefix_len (int): prefix length (e.g. 24)

    Returns:
        str: FQDN of the reverse zone (e.g. "1.0.10.in-addr.arpa.")
    '''
    net = ipaddress.ip_network(f'{address}/{prefix_len}', strict=False)
    octets = str(net.network_address).split('.')

    if prefix_len >= 24:
        significant = octets[:3]
    elif prefix_len >= 16:
        significant = octets[:2]
    else:
        significant = octets[:1]

    return '.'.join(reversed(significant)) + '.in-addr.arpa.'


# ------------------------------------------------------------------
# Create operations
# ------------------------------------------------------------------

def create_next_subnet(client: PortalClient, tag_key: str = '', tag_value: str = '',
                       cidr: int = 24, name: str = '', comment: str = '',
                       space: Optional[str] = None, block_id: Optional[str] = None,
                       dry_run: bool = False) -> PortalResult:
    '''
    Find an address block by tag (or use block_id directly) and create the next
    available subnet in it.

    Parameters:
        client (PortalClient): authenticated portal client
        tag_key (str): tag key to locate the target address block (ignored if block_id given)
        tag_value (str): tag value to locate the target address block (ignored if block_id given)
        cidr (int): prefix length of the new subnet (e.g. 24 for /24)
        name (str): optional name for the new subnet
        comment (str): optional comment
        space (str): optional IP space ID to narrow the address block search
        block_id (str): resource ID of the address block to use directly (takes priority
                        over tag_key/tag_value when supplied)
        dry_run (bool): when True, resolve lookups but do not create

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    data: dict = {'subnets': []}
    if dry_run:
        data['dry_run'] = True

    if block_id:
        block_label = f'id={block_id}'
        logger.info('Using address block directly: %s', block_id)
    else:
        blocks = client.find_address_blocks_by_tag(tag_key, tag_value, space=space)
        if not blocks:
            msg = f'No address block found with tag {tag_key}=={tag_value}'
            logger.error(msg)
            lines.append(f'ERROR: {msg}')
            return PortalResult(lines, data)

        if len(blocks) > 1:
            logger.warning('Multiple address blocks match tag %s==%s; using first', tag_key, tag_value)
            lines.append(f'WARNING: {len(blocks)} address blocks match tag {tag_key}=={tag_value}; using first')

        block = blocks[0]
        block_addr = getattr(block, 'address', '?')
        block_cidr = getattr(block, 'cidr', '?')
        block_id = getattr(block, 'id', '')
        block_label = f'{block_addr}/{block_cidr} (id={block_id})'
        logger.info('Using address block %s/%s id=%s', block_addr, block_cidr, block_id)

    lines.append(f'Address block: {block_label}')

    if dry_run:
        lines.append(f'{_DRY} Would create /{cidr} subnet in block {block_label}')
        if name:
            lines.append(f'{_DRY}   name={name}')
        if comment:
            lines.append(f'{_DRY}   comment={comment}')
        logger.info('Dry run — skipping subnet creation in block %s', block_id)
        return PortalResult(lines, data)

    subnets = client.create_next_available_subnet(block_id, cidr, name=name, comment=comment)
    if not subnets:
        msg = f'No subnet created in block {block_label}'
        logger.error(msg)
        lines.append(f'ERROR: {msg}')
        return PortalResult(lines, data)

    for subnet in subnets:
        s_cidr = _subnet_cidr(subnet)
        s_id = getattr(subnet, 'id', '')
        lines.append(f'Created subnet: {s_cidr} (id={s_id})')
        logger.info('Created subnet %s id=%s', s_cidr, s_id)
        data['subnets'].append(_obj_to_dict(subnet, 'id', 'address', 'cidr', 'name', 'comment'))

    return PortalResult(lines, data)


def create_dns_zone(client: PortalClient, fqdn: str, view: str,
                    primary_type: str = 'cloud', comment: str = '',
                    tags: Optional[dict] = None,
                    dry_run: bool = False) -> PortalResult:
    '''
    Create an authoritative DNS zone.

    Parameters:
        client (PortalClient): authenticated portal client
        fqdn (str): zone FQDN (e.g. "example.com" or "example.com.")
        view (str): resource ID of the DNS view to host the zone
        primary_type (str): zone primary type (default "cloud")
        comment (str): optional comment
        tags (dict): optional tags
        dry_run (bool): when True, resolve lookups but do not create

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    data: dict = {}
    if dry_run:
        data['dry_run'] = True
    fqdn_norm = fqdn.rstrip('.') + '.'

    existing = client.find_auth_zones(fqdn=fqdn_norm, view=view)
    if existing:
        zone_id = getattr(existing[0], 'id', '?')
        msg = f'Zone {fqdn_norm} already exists in view {view} (id={zone_id})'
        logger.warning(msg)
        lines.append(f'WARNING: {msg}')
        data['zone'] = _obj_to_dict(existing[0], 'id', 'fqdn', 'view', 'primary_type', 'comment')
        return PortalResult(lines, data)

    if dry_run:
        lines.append(f'{_DRY} Would create DNS zone: {fqdn_norm} in view {view}')
        if comment:
            lines.append(f'{_DRY}   comment={comment}')
        logger.info('Dry run — skipping zone creation for %s', fqdn_norm)
        return PortalResult(lines, data)

    zone = client.create_auth_zone(fqdn=fqdn_norm, view=view,
                                   primary_type=primary_type,
                                   comment=comment, tags=tags)
    zone_id = getattr(zone, 'id', '?')
    lines.append(f'Created DNS zone: {fqdn_norm} (id={zone_id})')
    logger.info('Created DNS zone %s id=%s', fqdn_norm, zone_id)
    data['zone'] = _obj_to_dict(zone, 'id', 'fqdn', 'view', 'primary_type', 'comment')
    return PortalResult(lines, data)


def create_dns_record(client: PortalClient, name_in_zone: str, zone_id: str,
                      rtype: str, rdata: str, view: str,
                      ttl: Optional[int] = None, comment: str = '',
                      tags: Optional[dict] = None,
                      dry_run: bool = False) -> PortalResult:
    '''
    Create a DNS resource record.

    Parameters:
        client (PortalClient): authenticated portal client
        name_in_zone (str): owner name relative to zone (e.g. "www")
        zone_id (str): resource ID of the authoritative zone
        rtype (str): record type (e.g. "A", "AAAA", "CNAME", "PTR")
        rdata (str): record data in presentation format
        view (str): resource ID of the DNS view
        ttl (int): optional TTL in seconds
        comment (str): optional comment
        tags (dict): optional tags
        dry_run (bool): when True, report intent but do not create

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    data: dict = {}
    if dry_run:
        data['dry_run'] = True

    rtype_upper = rtype.upper().strip()
    if not rtype_upper:
        lines.append('ERROR: Record type is required')
        return PortalResult(lines, data)

    if not zone_id:
        lines.append('ERROR: Zone must be selected before creating a record')
        return PortalResult(lines, data)

    if not name_in_zone:
        lines.append('ERROR: Name in zone is required (use @ for the zone apex)')
        return PortalResult(lines, data)

    if not rdata.strip():
        hint = _RDATA_FORMAT_HINTS.get(rtype_upper, 'record data string')
        lines.append(f'ERROR: Record data is required for {rtype_upper}. Format: {hint}')
        return PortalResult(lines, data)

    if dry_run:
        lines.append(f'{_DRY} Would create {rtype.upper()} record: {name_in_zone} -> {rdata}')
        lines.append(f'{_DRY}   zone={zone_id}')
        if ttl is not None:
            lines.append(f'{_DRY}   ttl={ttl}')
        if comment:
            lines.append(f'{_DRY}   comment={comment}')
        logger.info('Dry run — skipping record creation %s %s', rtype, name_in_zone)
        return PortalResult(lines, data)

    record = client.create_dns_record(
        name_in_zone=name_in_zone,
        zone=zone_id,
        rtype=rtype,
        rdata=rdata,
        view=view,
        ttl=ttl,
        comment=comment,
        tags=tags,
    )
    rec_id = getattr(record, 'id', '?')
    lines.append(f'Created {rtype.upper()} record: {name_in_zone} -> {rdata} (id={rec_id})')
    logger.info('Created %s record %s -> %s id=%s', rtype, name_in_zone, rdata, rec_id)
    data = {'record': _obj_to_dict(record, 'id', 'type', 'name_in_zone', 'rdata', 'ttl', 'comment', 'zone', 'view')}
    return PortalResult(lines, data)


def allocate_ip(client: PortalClient, tag_key: str = '', tag_value: str = '',
                count: int = 1, name: str = '', comment: str = '',
                space: Optional[str] = None, subnet_id: Optional[str] = None,
                dry_run: bool = False) -> PortalResult:
    '''
    Find a subnet by tag (or use subnet_id directly) and allocate the next available
    IP address(es) from it.

    Parameters:
        client (PortalClient): authenticated portal client
        tag_key (str): tag key to locate the target subnet (ignored if subnet_id given)
        tag_value (str): tag value to locate the target subnet (ignored if subnet_id given)
        count (int): number of IP addresses to allocate
        name (str): optional name for the address object(s)
        comment (str): optional comment
        space (str): optional IP space ID to narrow the subnet search
        subnet_id (str): resource ID of the subnet to use directly (takes priority
                         over tag_key/tag_value when supplied)
        dry_run (bool): when True, resolve lookups but do not allocate

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    data: dict = {'addresses': []}
    if dry_run:
        data['dry_run'] = True

    if subnet_id:
        subnet_label = f'id={subnet_id}'
        logger.info('Using subnet directly: %s', subnet_id)
    else:
        subnets = client.find_subnets_by_tag(tag_key, tag_value, space=space)
        if not subnets:
            msg = f'No subnet found with tag {tag_key}=={tag_value}'
            logger.error(msg)
            lines.append(f'ERROR: {msg}')
            return PortalResult(lines, data)

        if len(subnets) > 1:
            logger.warning('Multiple subnets match tag %s==%s; using first', tag_key, tag_value)
            lines.append(f'WARNING: {len(subnets)} subnets match tag {tag_key}=={tag_value}; using first')

        subnet = subnets[0]
        s_cidr = _subnet_cidr(subnet)
        subnet_id = getattr(subnet, 'id', '')
        subnet_label = f'{s_cidr} (id={subnet_id})'
        logger.info('Using subnet %s id=%s', s_cidr, subnet_id)

    lines.append(f'Subnet: {subnet_label}')

    if dry_run:
        noun = 'IP' if count == 1 else f'{count} IPs'
        lines.append(f'{_DRY} Would allocate {noun} from subnet {subnet_label}')
        if name:
            lines.append(f'{_DRY}   name={name}')
        logger.info('Dry run — skipping IP allocation from subnet %s', subnet_id)
        return PortalResult(lines, data)

    addresses = client.allocate_next_available_ip(subnet_id, count=count,
                                                  name=name, comment=comment)
    if not addresses:
        msg = f'No IP addresses allocated from subnet {subnet_label}'
        logger.error(msg)
        lines.append(f'ERROR: {msg}')
        return PortalResult(lines, data)

    for addr in addresses:
        ip = getattr(addr, 'address', '?')
        addr_id = getattr(addr, 'id', '')
        lines.append(f'Allocated IP: {ip} (id={addr_id})')
        logger.info('Allocated IP %s id=%s', ip, addr_id)
        data['addresses'].append(_obj_to_dict(addr, 'id', 'address', 'name', 'comment'))

    return PortalResult(lines, data)


def find_networks_by_tag(client: PortalClient, tag_key: str, tag_value: str,
                         network_type: str = 'subnet',
                         space: Optional[str] = None) -> PortalResult:
    '''
    Find networks (subnets or address blocks) matching a tag.

    Parameters:
        client (PortalClient): authenticated portal client
        tag_key (str): tag key to search for
        tag_value (str): tag value to search for
        network_type (str): "subnet" or "address_block"
        space (str): optional IP space ID to restrict the search

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []

    if network_type == 'address_block':
        results = client.find_address_blocks_by_tag(tag_key, tag_value, space=space)
        kind = 'address block'
        data_key = 'address_blocks'
    else:
        results = client.find_subnets_by_tag(tag_key, tag_value, space=space)
        kind = 'subnet'
        data_key = 'subnets'

    if not results:
        lines.append(f'No {kind}s found with tag {tag_key}=={tag_value}')
        return PortalResult(lines, {data_key: []})

    lines.append(f'Found {len(results)} {kind}(s) with tag {tag_key}=={tag_value}:')
    rows = []
    for obj in results:
        addr = getattr(obj, 'address', '?')
        cidr = getattr(obj, 'cidr', '?')
        obj_id = getattr(obj, 'id', '?')
        obj_name = getattr(obj, 'name', '') or ''
        name_part = f' name={obj_name}' if obj_name else ''
        lines.append(f'  {addr}/{cidr}{name_part} (id={obj_id})')
        logger.info('%s %s/%s id=%s', kind, addr, cidr, obj_id)
        rows.append(_obj_to_dict(obj, 'id', 'address', 'cidr', 'name', 'comment', 'space'))

    return PortalResult(lines, {data_key: rows})


# ------------------------------------------------------------------
# Modify operations
# ------------------------------------------------------------------

def modify_subnet(client: PortalClient, subnet_id: str,
                  name: Optional[str] = None, comment: Optional[str] = None,
                  tags: Optional[dict] = None,
                  dry_run: bool = False) -> PortalResult:
    '''
    Modify mutable fields on an existing subnet.

    Parameters:
        client (PortalClient): authenticated portal client
        subnet_id (str): resource ID of the subnet to modify
        name (str): new name, or None to leave unchanged
        comment (str): new comment, or None to leave unchanged
        tags (dict): replacement tags dict, or None to leave unchanged
        dry_run (bool): when True, read and report changes but do not write

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    updated = client.modify_subnet(subnet_id, name=name, comment=comment,
                                   tags=tags, dry_run=dry_run)
    s_cidr = _subnet_cidr(updated)
    prefix = f'{_DRY} Would modify' if dry_run else 'Modified'
    lines.append(f'{prefix} subnet: {s_cidr} (id={subnet_id})')
    if name is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}name -> {name}')
    if comment is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}comment -> {comment}')
    if tags is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}tags -> {tags}')
    if not dry_run:
        logger.info('Modified subnet %s id=%s', s_cidr, subnet_id)
    data = {'subnet': _obj_to_dict(updated, 'id', 'address', 'cidr', 'name', 'comment', 'tags')}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


def modify_dns_zone(client: PortalClient, zone_id: str,
                    comment: Optional[str] = None, tags: Optional[dict] = None,
                    disabled: Optional[bool] = None,
                    dry_run: bool = False) -> PortalResult:
    '''
    Modify mutable fields on an existing authoritative DNS zone.

    Parameters:
        client (PortalClient): authenticated portal client
        zone_id (str): resource ID of the zone to modify
        comment (str): new comment, or None to leave unchanged
        tags (dict): replacement tags dict, or None to leave unchanged
        disabled (bool): enable/disable the zone, or None to leave unchanged
        dry_run (bool): when True, read and report changes but do not write

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    updated = client.modify_auth_zone(zone_id, comment=comment, tags=tags,
                                      disabled=disabled, dry_run=dry_run)
    fqdn = getattr(updated, 'fqdn', zone_id)
    prefix = f'{_DRY} Would modify' if dry_run else 'Modified'
    lines.append(f'{prefix} DNS zone: {fqdn} (id={zone_id})')
    if comment is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}comment -> {comment}')
    if tags is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}tags -> {tags}')
    if disabled is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}disabled -> {disabled}')
    if not dry_run:
        logger.info('Modified DNS zone %s id=%s', fqdn, zone_id)
    data = {'zone': _obj_to_dict(updated, 'id', 'fqdn', 'view', 'comment', 'disabled', 'tags')}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


def modify_dns_record(client: PortalClient, record_id: str,
                      rdata: Optional[str] = None, ttl: Optional[int] = None,
                      comment: Optional[str] = None, tags: Optional[dict] = None,
                      disabled: Optional[bool] = None,
                      dry_run: bool = False) -> PortalResult:
    '''
    Modify mutable fields on an existing DNS resource record.

    Parameters:
        client (PortalClient): authenticated portal client
        record_id (str): resource ID of the record to modify
        rdata (str): new record data, or None to leave unchanged
        ttl (int): new TTL in seconds, or None to leave unchanged
        comment (str): new comment, or None to leave unchanged
        tags (dict): replacement tags dict, or None to leave unchanged
        disabled (bool): enable/disable the record, or None to leave unchanged
        dry_run (bool): when True, read and report changes but do not write

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    if not record_id:
        lines.append('ERROR: Record ID is required')
        return PortalResult(lines, {'dry_run': True} if dry_run else {})
    updated = client.modify_dns_record(record_id, rdata=rdata, ttl=ttl,
                                       comment=comment, tags=tags,
                                       disabled=disabled, dry_run=dry_run)
    name = getattr(updated, 'name_in_zone', record_id)
    rtype = getattr(updated, 'type', '?')
    prefix = f'{_DRY} Would modify' if dry_run else 'Modified'
    lines.append(f'{prefix} {rtype} record: {name} (id={record_id})')
    if rdata is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}rdata -> {rdata}')
    if ttl is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}ttl -> {ttl}')
    if comment is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}comment -> {comment}')
    if tags is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}tags -> {tags}')
    if disabled is not None:
        lines.append(f'  {"(would set) " if dry_run else ""}disabled -> {disabled}')
    if not dry_run:
        logger.info('Modified %s record %s id=%s', rtype, name, record_id)
    data = {'record': _obj_to_dict(updated, 'id', 'type', 'name_in_zone', 'rdata', 'ttl', 'comment', 'disabled', 'tags')}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


# ------------------------------------------------------------------
# Delete / release operations
# ------------------------------------------------------------------

def delete_subnet(client: PortalClient, subnet_id: str,
                  dry_run: bool = False) -> PortalResult:
    '''
    Delete a subnet.

    Parameters:
        client (PortalClient): authenticated portal client
        subnet_id (str): resource ID of the subnet to delete
        dry_run (bool): when True, report intent but do not delete

    Returns:
        PortalResult: summary lines and structured data
    '''
    client.delete_subnet(subnet_id, dry_run=dry_run)
    prefix = f'{_DRY} Would delete' if dry_run else 'Deleted'
    lines = [f'{prefix} subnet: id={subnet_id}']
    if not dry_run:
        logger.info('Deleted subnet id=%s', subnet_id)
    data = {'deleted': {'type': 'subnet', 'id': subnet_id}}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


def delete_dns_zone(client: PortalClient, zone_id: str,
                    dry_run: bool = False) -> PortalResult:
    '''
    Delete an authoritative DNS zone.

    Parameters:
        client (PortalClient): authenticated portal client
        zone_id (str): resource ID of the zone to delete
        dry_run (bool): when True, report intent but do not delete

    Returns:
        PortalResult: summary lines and structured data
    '''
    client.delete_auth_zone(zone_id, dry_run=dry_run)
    prefix = f'{_DRY} Would delete' if dry_run else 'Deleted'
    lines = [f'{prefix} DNS zone: id={zone_id}']
    if not dry_run:
        logger.info('Deleted DNS zone id=%s', zone_id)
    data = {'deleted': {'type': 'auth_zone', 'id': zone_id}}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


def delete_dns_record(client: PortalClient, record_id: str,
                      dry_run: bool = False) -> PortalResult:
    '''
    Delete a DNS resource record.

    Parameters:
        client (PortalClient): authenticated portal client
        record_id (str): resource ID of the record to delete
        dry_run (bool): when True, report intent but do not delete

    Returns:
        PortalResult: summary lines and structured data
    '''
    client.delete_dns_record(record_id, dry_run=dry_run)
    prefix = f'{_DRY} Would delete' if dry_run else 'Deleted'
    lines = [f'{prefix} DNS record: id={record_id}']
    if not dry_run:
        logger.info('Deleted DNS record id=%s', record_id)
    data = {'deleted': {'type': 'record', 'id': record_id}}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


def release_ip(client: PortalClient, address_id: str,
               dry_run: bool = False) -> PortalResult:
    '''
    Release an allocated IP address object.

    Parameters:
        client (PortalClient): authenticated portal client
        address_id (str): resource ID of the address to release
        dry_run (bool): when True, report intent but do not release

    Returns:
        PortalResult: summary lines and structured data
    '''
    client.release_ip(address_id, dry_run=dry_run)
    prefix = f'{_DRY} Would release' if dry_run else 'Released'
    lines = [f'{prefix} IP address: id={address_id}']
    if not dry_run:
        logger.info('Released IP address id=%s', address_id)
    data = {'deleted': {'type': 'address', 'id': address_id}}
    if dry_run:
        data['dry_run'] = True
    return PortalResult(lines, data)


# ------------------------------------------------------------------
# Provision workflow
# ------------------------------------------------------------------

def provision(client: PortalClient, tag_key: str, tag_value: str, cidr: int,
              name: str = '', comment: str = '',
              forward_zone_fqdn: Optional[str] = None,
              view_id: Optional[str] = None,
              create_reverse_zone: bool = False,
              tags: Optional[dict] = None,
              space: Optional[str] = None,
              dry_run: bool = False) -> PortalResult:
    '''
    End-to-end provisioning: allocate a subnet then optionally create
    forward and/or reverse DNS zones.

    Steps performed:
      1. Find address block by tag
      2. Create next available subnet (cidr)
      3. If forward_zone_fqdn and view_id: create forward auth zone
      4. If create_reverse_zone and view_id: derive and create in-addr.arpa zone

    Parameters:
        client (PortalClient): authenticated portal client
        tag_key (str): tag key to locate the address block
        tag_value (str): tag value to locate the address block
        cidr (int): prefix length of the new subnet
        name (str): optional name for the new subnet
        comment (str): optional comment applied to all created objects
        forward_zone_fqdn (str): FQDN for the forward DNS zone (optional)
        view_id (str): DNS view resource ID (required when creating zones)
        create_reverse_zone (bool): auto-create in-addr.arpa reverse zone
        tags (dict): tags applied to all created objects
        space (str): optional IP space ID to narrow the address block search
        dry_run (bool): when True, perform all lookups but skip all writes

    Returns:
        PortalResult: summary lines and combined structured data
    '''
    lines = []
    data: dict = {}
    if dry_run:
        data['dry_run'] = True

    # Step 1 + 2: subnet
    subnet_result = create_next_subnet(
        client, tag_key, tag_value, cidr,
        name=name, comment=comment, space=space, dry_run=dry_run,
    )
    lines.extend(subnet_result)

    if any(l.startswith('ERROR:') for l in subnet_result):
        return PortalResult(lines, data)

    subnets = subnet_result.data.get('subnets', [])
    data['subnet'] = subnets[0] if subnets else {}

    if not (forward_zone_fqdn or create_reverse_zone):
        return PortalResult(lines, data)

    if not view_id:
        msg = 'DNS zone creation requested but --view not supplied'
        logger.error(msg)
        lines.append(f'ERROR: {msg}')
        return PortalResult(lines, data)

    # Step 3: forward zone
    if forward_zone_fqdn:
        fwd_result = create_dns_zone(
            client, forward_zone_fqdn, view_id,
            comment=comment, tags=tags, dry_run=dry_run,
        )
        lines.extend(fwd_result)
        data['forward_zone'] = fwd_result.data.get('zone', {})

    # Step 4: reverse zone
    if create_reverse_zone:
        if dry_run:
            # Derive from the requested cidr and the first matching block address
            blocks = client.find_address_blocks_by_tag(tag_key, tag_value, space=space)
            subnet_addr = getattr(blocks[0], 'address', '') if blocks else ''
            subnet_cidr_val = cidr
        else:
            subnet_addr = subnets[0].get('address', '') if subnets else ''
            subnet_cidr_val = subnets[0].get('cidr') if subnets else None

        if subnet_addr and subnet_cidr_val is not None:
            rev_fqdn = _cidr_to_reverse_zone(subnet_addr, int(subnet_cidr_val))
            lines.append(f'Derived reverse zone: {rev_fqdn}')
            rev_result = create_dns_zone(
                client, rev_fqdn, view_id,
                comment=comment, tags=tags, dry_run=dry_run,
            )
            lines.extend(rev_result)
            data['reverse_zone'] = rev_result.data.get('zone', {})
        else:
            msg = 'Could not determine subnet address for reverse zone derivation'
            logger.warning(msg)
            lines.append(f'WARNING: {msg}')

    return PortalResult(lines, data)


# ------------------------------------------------------------------
# List / view operations
# ------------------------------------------------------------------

def list_ip_spaces(client: PortalClient, name_filter: Optional[str] = None,
                   tag_key: Optional[str] = None,
                   tag_value: Optional[str] = None) -> PortalResult:
    '''
    List IP spaces.

    Parameters:
        client (PortalClient): authenticated portal client
        name_filter (str): optional name substring filter
        tag_key (str): optional tag key filter
        tag_value (str): optional tag value filter (requires tag_key)

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    filter_expr = f'name~"{name_filter}"' if name_filter else None
    tfilter = f'{tag_key}=="{tag_value}"' if (tag_key and tag_value) else None

    spaces = client.list_ip_spaces(filter_expr=filter_expr, tfilter=tfilter)

    if not spaces:
        lines.append('No IP spaces found')
        return PortalResult(lines, {'spaces': []})

    lines.append(f'Found {len(spaces)} IP space(s):')
    rows = []
    for sp in spaces:
        sp_id = getattr(sp, 'id', '?')
        sp_name = getattr(sp, 'name', '') or ''
        sp_comment = getattr(sp, 'comment', '') or ''
        lines.append(f'  {sp_name}  (id={sp_id})')
        if sp_comment:
            lines.append(f'    {sp_comment}')
        rows.append(_obj_to_dict(sp, 'id', 'name', 'comment'))

    return PortalResult(lines, {'spaces': rows})


def list_views(client: PortalClient, name_filter: Optional[str] = None,
               tag_key: Optional[str] = None,
               tag_value: Optional[str] = None) -> PortalResult:
    '''
    List DNS views.

    Parameters:
        client (PortalClient): authenticated portal client
        name_filter (str): optional name substring filter
        tag_key (str): optional tag key filter
        tag_value (str): optional tag value filter (requires tag_key)

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    filter_expr = f'name~"{name_filter}"' if name_filter else None
    tfilter = f'{tag_key}=="{tag_value}"' if (tag_key and tag_value) else None

    views = client.list_views(filter_expr=filter_expr, tfilter=tfilter)

    if not views:
        lines.append('No DNS views found')
        return PortalResult(lines, {'views': []})

    lines.append(f'Found {len(views)} DNS view(s):')
    rows = []
    for v in views:
        v_id = getattr(v, 'id', '?')
        v_name = getattr(v, 'name', '') or ''
        v_comment = getattr(v, 'comment', '') or ''
        lines.append(f'  {v_name}  (id={v_id})')
        if v_comment:
            lines.append(f'    {v_comment}')
        rows.append(_obj_to_dict(v, 'id', 'name', 'comment'))

    return PortalResult(lines, {'views': rows})


def list_zone_records(client: PortalClient, zone_id: str,
                      rtype: Optional[str] = None,
                      name_filter: Optional[str] = None) -> PortalResult:
    '''
    List DNS records in an authoritative zone.

    Parameters:
        client (PortalClient): authenticated portal client
        zone_id (str): resource ID of the zone to query
        rtype (str): optional record type filter (e.g. "A", "MX")
        name_filter (str): optional name_in_zone exact-match filter

    Returns:
        PortalResult: summary lines and structured data with a 'records' list
    '''
    lines = []

    if not zone_id:
        lines.append('ERROR: Zone must be selected')
        return PortalResult(lines, {'records': []})

    records = client.find_dns_records(zone_id, rtype=rtype or None,
                                      name_in_zone=name_filter or None)

    if not records:
        lines.append('No records found in this zone')
        return PortalResult(lines, {'records': []})

    lines.append(f'Found {len(records)} record(s):')
    rows = []
    for r in records:
        name = getattr(r, 'name_in_zone', '') or ''
        rtype_val = getattr(r, 'type', '') or ''
        ttl = getattr(r, 'ttl', None)
        rdata_text = getattr(r, 'dns_rdata', '') or ''
        comment = getattr(r, 'comment', '') or ''
        disabled = getattr(r, 'disabled', False) or False
        lines.append(f'  {name or "@"} {rtype_val} {ttl or ""} {rdata_text}')
        rows.append({
            'id': getattr(r, 'id', ''),
            'name_in_zone': name or '@',
            'type': rtype_val,
            'ttl': ttl,
            'dns_rdata': rdata_text,
            'comment': comment,
            'disabled': disabled,
        })

    return PortalResult(lines, {'records': rows, 'zone_id': zone_id})


def list_address_blocks(client: PortalClient, name_filter: Optional[str] = None,
                        tag_key: Optional[str] = None, tag_value: Optional[str] = None,
                        space: Optional[str] = None) -> PortalResult:
    '''
    List address blocks with optional filtering.

    Parameters:
        client (PortalClient): authenticated portal client
        name_filter (str): optional name substring filter
        tag_key (str): optional tag key filter
        tag_value (str): optional tag value filter (requires tag_key)
        space (str): optional IP space ID to restrict the search

    Returns:
        PortalResult: summary lines and structured data
    '''
    lines = []
    filter_expr = f'name~"{name_filter}"' if name_filter else None
    tfilter = f'{tag_key}=="{tag_value}"' if (tag_key and tag_value) else None

    blocks = client.list_address_blocks(filter_expr=filter_expr, tfilter=tfilter, space=space)

    if not blocks:
        lines.append('No address blocks found')
        return PortalResult(lines, {'address_blocks': []})

    lines.append(f'Found {len(blocks)} address block(s):')
    rows = []
    for blk in blocks:
        blk_id = getattr(blk, 'id', '?')
        addr = getattr(blk, 'address', '?')
        cidr = getattr(blk, 'cidr', '?')
        blk_name = getattr(blk, 'name', '') or ''
        name_part = f' {blk_name}' if blk_name else ''
        lines.append(f'  {addr}/{cidr}{name_part}  (id={blk_id})')
        rows.append(_obj_to_dict(blk, 'id', 'address', 'cidr', 'name', 'comment', 'space'))

    return PortalResult(lines, {'address_blocks': rows})
