#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: client.py
 Author: Chris Marrison
 Description: Universal DDI API client wrapper for the self-service portal

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import logging
from typing import Optional

from universal_ddi_client import Configuration, ApiClient
import ipam
import dns_config
import dns_data
import ipam.api.address_api as _address_mod
import ipam.api.ip_space_api as _ip_space_mod
import dns_config.api.view_api as _view_mod

logger = logging.getLogger(__name__)


def _rdata_str_to_dict(rtype: str, rdata_str: str) -> dict:
    '''
    Convert a presentation-format rdata string to the API rdata dict.

    The Universal DDI DNS Data API requires rdata as a typed dict rather
    than a plain string. The required keys differ by record type as
    documented in the Record model.

    Parameters:
        rtype (str): record type mnemonic (e.g. "A", "MX", "TXT")
        rdata_str (str): rdata in presentation/zone-file text format

    Returns:
        dict: rdata dict suitable for dns_data.Record(rdata=...)
    '''
    rtype = rtype.upper().strip()
    s = rdata_str.strip()

    if not s:
        raise ValueError(f'rdata is required for {rtype} records')

    if rtype in ('A', 'AAAA'):
        return {'address': s}

    if rtype == 'CNAME':
        return {'cname': s}

    if rtype in ('PTR', 'NS'):
        return {'dname': s}

    if rtype == 'DNAME':
        return {'target': s}

    if rtype == 'TXT':
        if s.startswith('"') and s.endswith('"') and len(s) >= 2:
            s = s[1:-1]
        return {'text': s}

    if rtype == 'MX':
        parts = s.split(None, 1)
        if len(parts) != 2:
            raise ValueError(
                f'MX rdata must be "preference exchange" (e.g. "10 mail.example.com."), got: {s!r}')
        try:
            return {'preference': int(parts[0]), 'exchange': parts[1]}
        except ValueError:
            raise ValueError(
                f'MX preference must be an integer, got: {parts[0]!r}')

    if rtype == 'SRV':
        parts = s.split(None, 3)
        if len(parts) != 4:
            raise ValueError(
                f'SRV rdata must be "priority weight port target" '
                f'(e.g. "10 0 443 host.example.com."), got: {s!r}')
        try:
            return {'priority': int(parts[0]), 'weight': int(parts[1]),
                    'port': int(parts[2]), 'target': parts[3]}
        except ValueError as exc:
            raise ValueError(f'SRV rdata contains non-integer field: {exc}')

    if rtype == 'CAA':
        parts = s.split(None, 2)
        if len(parts) != 3:
            raise ValueError(
                f'CAA rdata must be "flags tag value" '
                f'(e.g. "0 issue letsencrypt.org"), got: {s!r}')
        try:
            return {'flags': int(parts[0]), 'tag': parts[1], 'value': parts[2]}
        except ValueError:
            raise ValueError(f'CAA flags must be an integer, got: {parts[0]!r}')

    # Generic fallback — wrap as PRESENTATION subfield
    return {'subfields': [{'type': 'PRESENTATION', 'value': s}]}


class PortalClient:
    '''
    Facade over the Universal DDI Python client covering IPAM, DNS config,
    and DNS data operations needed by the self-service portal.
    '''

    def __init__(self, api_key: str, base_url: str = 'https://csp.infoblox.com',
                 verify_ssl: bool = True) -> None:
        '''
        Initialise API client with credentials

        Parameters:
            api_key (str): Infoblox portal API key
            base_url (str): Cloud Services Portal URL
            verify_ssl (bool): verify SSL certificates

        Returns:
            PortalClient object
        '''
        config = Configuration(
            portal_url=base_url,
            portal_key=api_key,
        )
        config.verify_ssl = verify_ssl
        self._api_client = ApiClient(config)

        self._address_block_api = ipam.AddressBlockApi(self._api_client)
        self._subnet_api = ipam.SubnetApi(self._api_client)
        self._address_api = _address_mod.AddressApi(self._api_client)
        self._ip_space_api = _ip_space_mod.IpSpaceApi(self._api_client)
        self._auth_zone_api = dns_config.AuthZoneApi(self._api_client)
        self._view_api = _view_mod.ViewApi(self._api_client)
        self._record_api = dns_data.RecordApi(self._api_client)
        logger.debug('PortalClient initialised for %s', base_url)

    # ------------------------------------------------------------------
    # Address block helpers
    # ------------------------------------------------------------------

    def find_address_blocks_by_tag(self, tag_key: str, tag_value: str,
                                   space: Optional[str] = None) -> list:
        '''
        Return all address blocks that carry a given tag key/value pair.

        Parameters:
            tag_key (str): tag key to match
            tag_value (str): tag value to match
            space (str): optional IP space ID to restrict the search

        Returns:
            list: AddressBlock objects
        '''
        tfilter = f'{tag_key}=="{tag_value}"'
        filter_expr = f'space=="{space}"' if space else None
        logger.debug('Listing address blocks tfilter=%s filter=%s', tfilter, filter_expr)

        resp = self._address_block_api.list(tfilter=tfilter, filter=filter_expr)
        results = resp.results or []
        logger.debug('Found %d address block(s)', len(results))
        return results

    def create_next_available_subnet(self, address_block_id: str, cidr: int,
                                     name: str = '', comment: str = '') -> list:
        '''
        Allocate the next available subnet from an address block.

        Parameters:
            address_block_id (str): resource ID of the address block
            cidr (int): prefix length of the subnet to create
            name (str): optional name for the new subnet
            comment (str): optional comment

        Returns:
            list: created Subnet objects (typically one element)
        '''
        logger.debug('Creating next available /%d subnet in block %s', cidr, address_block_id)
        resp = self._address_block_api.create_next_available_subnet(
            id=address_block_id,
            cidr=cidr,
            name=name or None,
            comment=comment or None,
        )
        results = resp.results or []
        logger.debug('Created %d subnet(s)', len(results))
        return results

    # ------------------------------------------------------------------
    # Subnet helpers
    # ------------------------------------------------------------------

    def find_subnets_by_tag(self, tag_key: str, tag_value: str,
                            space: Optional[str] = None) -> list:
        '''
        Return all subnets that carry a given tag key/value pair.

        Parameters:
            tag_key (str): tag key to match
            tag_value (str): tag value to match
            space (str): optional IP space ID to restrict the search

        Returns:
            list: Subnet objects
        '''
        tfilter = f'{tag_key}=="{tag_value}"'
        filter_expr = f'space=="{space}"' if space else None
        logger.debug('Listing subnets tfilter=%s filter=%s', tfilter, filter_expr)

        resp = self._subnet_api.list(tfilter=tfilter, filter=filter_expr)
        results = resp.results or []
        logger.debug('Found %d subnet(s)', len(results))
        return results

    def allocate_next_available_ip(self, subnet_id: str, count: int = 1,
                                   name: str = '', comment: str = '') -> list:
        '''
        Reserve the next available IP address(es) inside a subnet.

        Parameters:
            subnet_id (str): resource ID of the subnet
            count (int): number of addresses to reserve
            name (str): optional name for the address object
            comment (str): optional comment

        Returns:
            list: created Address objects
        '''
        logger.debug('Allocating %d IP(s) from subnet %s', count, subnet_id)
        resp = self._subnet_api.create_next_available_ip(
            id=subnet_id,
            count=count,
            name=name or None,
            comment=comment or None,
        )
        results = resp.results or []
        logger.debug('Allocated %d IP(s)', len(results))
        return results

    # ------------------------------------------------------------------
    # DNS auth zone helpers
    # ------------------------------------------------------------------

    def create_auth_zone(self, fqdn: str, view: str, primary_type: str = 'cloud',
                         comment: str = '', tags: Optional[dict] = None) -> object:
        '''
        Create an authoritative DNS zone.

        Parameters:
            fqdn (str): fully-qualified domain name for the zone (e.g. example.com.)
            view (str): resource ID of the DNS view that will host the zone
            primary_type (str): zone primary type (default "cloud")
            comment (str): optional comment
            tags (dict): optional tags dict

        Returns:
            AuthZone: the created zone object
        '''
        fqdn = fqdn.rstrip('.') + '.'
        body = dns_config.AuthZone(
            fqdn=fqdn,
            view=view,
            primary_type=primary_type,
            comment=comment or None,
            tags=tags,
        )
        logger.debug('Creating auth zone fqdn=%s view=%s', fqdn, view)
        resp = self._auth_zone_api.create(body=body)
        zone = resp.result
        logger.debug('Created auth zone id=%s', getattr(zone, 'id', '?'))
        return zone

    def find_auth_zones(self, fqdn: Optional[str] = None,
                        view: Optional[str] = None) -> list:
        '''
        List authoritative zones, optionally filtered by FQDN and/or view.

        Parameters:
            fqdn (str): optional zone FQDN to match
            view (str): optional view resource ID

        Returns:
            list: AuthZone objects
        '''
        parts = []
        if fqdn:
            parts.append(f'fqdn=="{fqdn.rstrip(".") + "."}"')
        if view:
            parts.append(f'view=="{view}"')
        filter_expr = ' and '.join(parts) if parts else None

        logger.debug('Listing auth zones filter=%s', filter_expr)
        resp = self._auth_zone_api.list(filter=filter_expr)
        return resp.results or []

    # ------------------------------------------------------------------
    # DNS record helpers
    # ------------------------------------------------------------------

    def create_dns_record(self, name_in_zone: str, zone: str, rtype: str,
                          rdata: str, view: str, ttl: Optional[int] = None,
                          comment: str = '', tags: Optional[dict] = None) -> object:
        '''
        Create a DNS resource record.

        Parameters:
            name_in_zone (str): record owner name relative to the zone (e.g. "www")
            zone (str): resource ID of the authoritative zone
            rtype (str): record type (e.g. "A", "AAAA", "CNAME", "PTR", "MX")
            rdata (str): record data in presentation format (e.g. "192.0.2.1")
            view (str): resource ID of the DNS view
            ttl (int): optional TTL in seconds
            comment (str): optional comment
            tags (dict): optional tags dict

        Returns:
            Record: the created record object
        '''
        zone_id = zone or None
        body = dns_data.Record(
            name_in_zone=name_in_zone or None,
            zone=zone_id,
            type=rtype.upper(),
            rdata=_rdata_str_to_dict(rtype, rdata),
            # The API has two mutually exclusive creation approaches:
            #   (1) name_in_zone + zone  — view auto-retrieved from zone
            #   (2) absolute_name_spec + view — zone auto-computed
            # Sending view alongside zone causes the API to attempt (2) and
            # reject the request because absolute_name_spec is absent.
            view=None if zone_id else (view or None),
            ttl=ttl,
            comment=comment or None,
            tags=tags,
        )
        logger.debug('Creating %s record %s in zone %s', rtype, name_in_zone, zone)
        resp = self._record_api.create(body=body)
        record = resp.result
        logger.debug('Created record id=%s', getattr(record, 'id', '?'))
        return record

    def find_dns_records(self, zone: str, rtype: Optional[str] = None,
                         name_in_zone: Optional[str] = None) -> list:
        '''
        List DNS records in a zone, optionally filtered by type and/or name.

        Parameters:
            zone (str): resource ID of the authoritative zone
            rtype (str): optional record type filter
            name_in_zone (str): optional owner name filter

        Returns:
            list: Record objects
        '''
        parts = [f'zone=="{zone}"']
        if rtype:
            parts.append(f'type=="{rtype.upper()}"')
        if name_in_zone:
            parts.append(f'name_in_zone=="{name_in_zone}"')
        filter_expr = ' and '.join(parts)

        logger.debug('Listing records filter=%s', filter_expr)
        resp = self._record_api.list(filter=filter_expr)
        return resp.results or []

    # ------------------------------------------------------------------
    # Modify (update) helpers — read-modify-write
    # ------------------------------------------------------------------

    def modify_subnet(self, subnet_id: str, name: Optional[str] = None,
                      comment: Optional[str] = None,
                      tags: Optional[dict] = None,
                      dry_run: bool = False) -> object:
        '''
        Update mutable fields on an existing subnet.

        Performs a read-modify-write; only supplied (non-None) fields are changed.
        When dry_run=True the write is skipped and the in-memory modified object
        is returned so callers can inspect what would change.

        Parameters:
            subnet_id (str): resource ID of the subnet to modify
            name (str): new name, or None to leave unchanged
            comment (str): new comment, or None to leave unchanged
            tags (dict): replacement tags dict, or None to leave unchanged
            dry_run (bool): when True, read and apply changes but do not write

        Returns:
            Subnet: the (would-be) updated subnet object
        '''
        logger.debug('Reading subnet %s for modification', subnet_id)
        current = self._subnet_api.read(id=subnet_id).result

        if name is not None:
            current.name = name
        if comment is not None:
            current.comment = comment
        if tags is not None:
            current.tags = tags

        if dry_run:
            logger.debug('Dry run — skipping write for subnet %s', subnet_id)
            return current

        logger.debug('Updating subnet %s', subnet_id)
        resp = self._subnet_api.update(id=subnet_id, body=current)
        updated = resp.result
        logger.debug('Updated subnet id=%s', getattr(updated, 'id', '?'))
        return updated

    def modify_auth_zone(self, zone_id: str, comment: Optional[str] = None,
                         tags: Optional[dict] = None,
                         disabled: Optional[bool] = None,
                         dry_run: bool = False) -> object:
        '''
        Update mutable fields on an existing authoritative zone.

        Performs a read-modify-write; only supplied (non-None) fields are changed.
        When dry_run=True the write is skipped and the in-memory modified object
        is returned so callers can inspect what would change.

        Parameters:
            zone_id (str): resource ID of the zone to modify
            comment (str): new comment, or None to leave unchanged
            tags (dict): replacement tags dict, or None to leave unchanged
            disabled (bool): set zone disabled state, or None to leave unchanged
            dry_run (bool): when True, read and apply changes but do not write

        Returns:
            AuthZone: the (would-be) updated zone object
        '''
        logger.debug('Reading auth zone %s for modification', zone_id)
        current = self._auth_zone_api.read(id=zone_id).result

        if comment is not None:
            current.comment = comment
        if tags is not None:
            current.tags = tags
        if disabled is not None:
            current.disabled = disabled

        if dry_run:
            logger.debug('Dry run — skipping write for auth zone %s', zone_id)
            return current

        logger.debug('Updating auth zone %s', zone_id)
        resp = self._auth_zone_api.update(id=zone_id, body=current)
        updated = resp.result
        logger.debug('Updated auth zone id=%s', getattr(updated, 'id', '?'))
        return updated

    def modify_dns_record(self, record_id: str, rdata: Optional[str] = None,
                          ttl: Optional[int] = None, comment: Optional[str] = None,
                          tags: Optional[dict] = None,
                          disabled: Optional[bool] = None,
                          dry_run: bool = False) -> object:
        '''
        Update mutable fields on an existing DNS resource record.

        Performs a read-modify-write; only supplied (non-None) fields are changed.
        When dry_run=True the write is skipped and the in-memory modified object
        is returned so callers can inspect what would change.

        Parameters:
            record_id (str): resource ID of the record to modify
            rdata (str): new record data in presentation format, or None to leave unchanged
            ttl (int): new TTL in seconds, or None to leave unchanged
            comment (str): new comment, or None to leave unchanged
            tags (dict): replacement tags dict, or None to leave unchanged
            disabled (bool): set record disabled state, or None to leave unchanged
            dry_run (bool): when True, read and apply changes but do not write

        Returns:
            Record: the (would-be) updated record object
        '''
        logger.debug('Reading DNS record %s for modification', record_id)
        current = self._record_api.read(id=record_id).result

        rtype = getattr(current, 'type', '') or ''
        new_rdata = _rdata_str_to_dict(rtype, rdata) if rdata is not None else getattr(current, 'rdata', None)
        new_ttl = ttl if ttl is not None else getattr(current, 'ttl', None)
        new_comment = comment if comment is not None else getattr(current, 'comment', None)
        new_tags = tags if tags is not None else getattr(current, 'tags', None)
        new_disabled = disabled if disabled is not None else getattr(current, 'disabled', None)

        # Build a minimal body with only mutable fields — avoids sending
        # read-only fields (compartment_id, etc.) that the API rejects.
        body = dns_data.Record(
            rdata=new_rdata,
            ttl=new_ttl,
            comment=new_comment,
            tags=new_tags,
            disabled=new_disabled,
        )

        if dry_run:
            logger.debug('Dry run — skipping write for DNS record %s', record_id)
            current.rdata = new_rdata
            current.ttl = new_ttl
            current.comment = new_comment
            current.tags = new_tags
            current.disabled = new_disabled
            return current

        logger.debug('Updating DNS record %s', record_id)
        resp = self._record_api.update(id=record_id, body=body)
        updated = resp.result
        logger.debug('Updated DNS record id=%s', getattr(updated, 'id', '?'))
        return updated

    # ------------------------------------------------------------------
    # Delete / release helpers
    # ------------------------------------------------------------------

    def delete_subnet(self, subnet_id: str, dry_run: bool = False) -> None:
        '''
        Delete a subnet by resource ID.

        Parameters:
            subnet_id (str): resource ID of the subnet to delete
            dry_run (bool): when True, log intent but do not delete

        Returns:
            None
        '''
        if dry_run:
            logger.debug('Dry run — skipping delete for subnet %s', subnet_id)
            return
        logger.debug('Deleting subnet %s', subnet_id)
        self._subnet_api.delete(id=subnet_id)

    def delete_auth_zone(self, zone_id: str, dry_run: bool = False) -> None:
        '''
        Delete an authoritative DNS zone by resource ID.

        Parameters:
            zone_id (str): resource ID of the zone to delete
            dry_run (bool): when True, log intent but do not delete

        Returns:
            None
        '''
        if dry_run:
            logger.debug('Dry run — skipping delete for auth zone %s', zone_id)
            return
        logger.debug('Deleting auth zone %s', zone_id)
        self._auth_zone_api.delete(id=zone_id)

    def delete_dns_record(self, record_id: str, dry_run: bool = False) -> None:
        '''
        Delete a DNS resource record by resource ID.

        Parameters:
            record_id (str): resource ID of the record to delete
            dry_run (bool): when True, log intent but do not delete

        Returns:
            None
        '''
        if dry_run:
            logger.debug('Dry run — skipping delete for DNS record %s', record_id)
            return
        logger.debug('Deleting DNS record %s', record_id)
        self._record_api.delete(id=record_id)

    def release_ip(self, address_id: str, dry_run: bool = False) -> None:
        '''
        Release (delete) an allocated IP address object.

        Parameters:
            address_id (str): resource ID of the address object to release
            dry_run (bool): when True, log intent but do not delete

        Returns:
            None
        '''
        if dry_run:
            logger.debug('Dry run — skipping release for address %s', address_id)
            return
        logger.debug('Releasing IP address %s', address_id)
        self._address_api.delete(id=address_id)

    # ------------------------------------------------------------------
    # List / view helpers
    # ------------------------------------------------------------------

    def list_ip_spaces(self, filter_expr: Optional[str] = None,
                       tfilter: Optional[str] = None) -> list:
        '''
        List IP spaces, optionally filtered.

        Parameters:
            filter_expr (str): field filter expression (e.g. 'name=="default"')
            tfilter (str): tag filter expression

        Returns:
            list: IpSpace objects
        '''
        logger.debug('Listing IP spaces filter=%s tfilter=%s', filter_expr, tfilter)
        resp = self._ip_space_api.list(filter=filter_expr, tfilter=tfilter)
        return resp.results or []

    def list_views(self, filter_expr: Optional[str] = None,
                   tfilter: Optional[str] = None) -> list:
        '''
        List DNS views, optionally filtered.

        Parameters:
            filter_expr (str): field filter expression (e.g. 'name=="default"')
            tfilter (str): tag filter expression

        Returns:
            list: View objects
        '''
        logger.debug('Listing DNS views filter=%s tfilter=%s', filter_expr, tfilter)
        resp = self._view_api.list(filter=filter_expr, tfilter=tfilter)
        return resp.results or []

    def list_subnets(self, filter_expr: Optional[str] = None,
                    tfilter: Optional[str] = None,
                    space: Optional[str] = None,
                    parent: Optional[str] = None) -> list:
        '''
        List subnets, optionally filtered.

        Parameters:
            filter_expr (str): field filter expression
            tfilter (str): tag filter expression
            space (str): optional IP space ID to restrict the search
            parent (str): optional address block ID to restrict to direct children

        Returns:
            list: Subnet objects
        '''
        parts = []
        if filter_expr:
            parts.append(filter_expr)
        if space:
            parts.append(f'space=="{space}"')
        if parent:
            parts.append(f'parent=="{parent}"')
        combined = ' and '.join(parts) if parts else None

        logger.debug('Listing subnets filter=%s tfilter=%s', combined, tfilter)
        resp = self._subnet_api.list(filter=combined, tfilter=tfilter)
        return resp.results or []

    def list_addresses(self, subnet_id: str) -> list:
        '''
        List IP address objects allocated within a subnet.

        Parameters:
            subnet_id (str): resource ID of the subnet to query

        Returns:
            list: Address objects
        '''
        filter_expr = f'subnet=="{subnet_id}"'
        logger.debug('Listing addresses in subnet %s', subnet_id)
        resp = self._address_api.list(filter=filter_expr)
        return resp.results or []

    def list_address_blocks(self, filter_expr: Optional[str] = None,
                            tfilter: Optional[str] = None,
                            space: Optional[str] = None) -> list:
        '''
        List address blocks, optionally filtered.

        Parameters:
            filter_expr (str): field filter expression
            tfilter (str): tag filter expression
            space (str): optional IP space ID to restrict the search

        Returns:
            list: AddressBlock objects
        '''
        parts = []
        if filter_expr:
            parts.append(filter_expr)
        if space:
            parts.append(f'space=="{space}"')
        combined = ' and '.join(parts) if parts else None

        logger.debug('Listing address blocks filter=%s tfilter=%s', combined, tfilter)
        resp = self._address_block_api.list(filter=combined, tfilter=tfilter)
        return resp.results or []
