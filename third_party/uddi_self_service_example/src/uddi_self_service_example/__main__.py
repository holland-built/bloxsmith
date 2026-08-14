#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: __main__.py
 Author: Chris Marrison
 Description: CLI entry point for uddi_self_service_example

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import argparse
import logging
import sys
from typing import Optional

from .config import resolve_credentials, DEFAULT_INI_FILE
from .client import PortalClient
from .output import Formatter, FORMATS
from . import portal

logger = logging.getLogger(__name__)


def parseargs() -> argparse.Namespace:
    '''
    Parse command line arguments

    Returns:
        argparse.Namespace: parsed arguments
    '''
    parser = argparse.ArgumentParser(
        description='Universal DDI self-service portal',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''\
subcommands (create):
  create-subnet     Allocate next available subnet from an address block found by tag
  create-zone       Create an authoritative DNS zone
  create-record     Create a DNS resource record
  allocate-ip       Allocate next available IP address(es) from a subnet found by tag

subcommands (modify):
  modify-subnet     Modify name, comment, or tags on an existing subnet
  modify-zone       Modify comment, tags, or disabled state on an existing DNS zone
  modify-record     Modify rdata, TTL, comment, tags, or disabled state on an existing DNS record

subcommands (delete):
  delete-subnet     Delete a subnet
  delete-zone       Delete an authoritative DNS zone
  delete-record     Delete a DNS resource record
  release-ip        Release an allocated IP address

subcommands (view):
  find-networks     List subnets or address blocks matching a tag
  list-spaces       List IP spaces
  list-views        List DNS views
  list-address-blocks  List address blocks

subcommands (provision):
  provision         Allocate subnet + optionally create forward/reverse DNS zones
''',
    )

    # Global options
    parser.add_argument('-i', '--ini', default=DEFAULT_INI_FILE,
                        help=f'Path to ini credentials file (default: {DEFAULT_INI_FILE})')
    parser.add_argument('-k', '--api-key', default='',
                        help='API key (overrides ini file and environment variable)')
    parser.add_argument('-o', '--output', choices=FORMATS, default='text',
                        help='Output format: text (default), json, or table')
    parser.add_argument('-d', '--debug', action='store_true',
                        help='Enable debug logging')
    parser.add_argument('--no-verify-ssl', action='store_true', dest='no_verify_ssl',
                        help='Disable SSL certificate verification (useful for self-signed certs)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Perform all lookups but skip write operations; '
                             'output shows what would have been created/modified/deleted')

    subparsers = parser.add_subparsers(dest='subcommand', metavar='subcommand')
    subparsers.required = True

    # ------------------------------------------------------------------
    # create-subnet
    # ------------------------------------------------------------------
    p_subnet = subparsers.add_parser(
        'create-subnet',
        help='Allocate next available subnet from an address block found by tag',
    )
    p_subnet.add_argument('--tag-key', required=True,
                          help='Tag key to locate the address block')
    p_subnet.add_argument('--tag-value', required=True,
                          help='Tag value to locate the address block')
    p_subnet.add_argument('--cidr', required=True, type=int,
                          help='Prefix length for the new subnet (e.g. 24)')
    p_subnet.add_argument('--name', default='',
                          help='Name for the new subnet')
    p_subnet.add_argument('--comment', default='',
                          help='Comment for the new subnet')
    p_subnet.add_argument('--space', default='',
                          help='IP space resource ID (optional, narrows search)')

    # ------------------------------------------------------------------
    # create-zone
    # ------------------------------------------------------------------
    p_zone = subparsers.add_parser(
        'create-zone',
        help='Create an authoritative DNS zone',
    )
    p_zone.add_argument('--fqdn', required=True,
                        help='Zone FQDN (e.g. example.com)')
    p_zone.add_argument('--view', required=True,
                        help='DNS view resource ID')
    p_zone.add_argument('--primary-type', default='cloud',
                        help='Zone primary type (default: cloud)')
    p_zone.add_argument('--comment', default='',
                        help='Comment for the zone')
    p_zone.add_argument('--tag', action='append', default=[],
                        metavar='KEY=VALUE',
                        help='Tag in key=value format (repeatable)')

    # ------------------------------------------------------------------
    # create-record
    # ------------------------------------------------------------------
    p_record = subparsers.add_parser(
        'create-record',
        help='Create a DNS resource record',
    )
    p_record.add_argument('--name', required=True,
                          help='Owner name relative to zone (e.g. www)')
    p_record.add_argument('--zone', required=True,
                          help='Authoritative zone resource ID')
    p_record.add_argument('--type', required=True, dest='rtype',
                          help='Record type (e.g. A, AAAA, CNAME, PTR)')
    p_record.add_argument('--rdata', required=True,
                          help='Record data in presentation format')
    p_record.add_argument('--view', required=True,
                          help='DNS view resource ID')
    p_record.add_argument('--ttl', type=int, default=None,
                          help='TTL in seconds (optional)')
    p_record.add_argument('--comment', default='',
                          help='Comment for the record')
    p_record.add_argument('--tag', action='append', default=[],
                          metavar='KEY=VALUE',
                          help='Tag in key=value format (repeatable)')

    # ------------------------------------------------------------------
    # allocate-ip
    # ------------------------------------------------------------------
    p_ip = subparsers.add_parser(
        'allocate-ip',
        help='Allocate next available IP address(es) from a subnet found by tag',
    )
    p_ip.add_argument('--tag-key', required=True,
                      help='Tag key to locate the subnet')
    p_ip.add_argument('--tag-value', required=True,
                      help='Tag value to locate the subnet')
    p_ip.add_argument('--count', type=int, default=1,
                      help='Number of IP addresses to allocate (default: 1)')
    p_ip.add_argument('--name', default='',
                      help='Name for the address object(s)')
    p_ip.add_argument('--comment', default='',
                      help='Comment')
    p_ip.add_argument('--space', default='',
                      help='IP space resource ID (optional, narrows search)')

    # ------------------------------------------------------------------
    # modify-subnet
    # ------------------------------------------------------------------
    p_mod_subnet = subparsers.add_parser(
        'modify-subnet',
        help='Modify name, comment, or tags on an existing subnet',
    )
    p_mod_subnet.add_argument('--id', required=True, dest='subnet_id',
                              help='Resource ID of the subnet to modify')
    p_mod_subnet.add_argument('--name', default=None,
                              help='New name (omit to leave unchanged)')
    p_mod_subnet.add_argument('--comment', default=None,
                              help='New comment (omit to leave unchanged)')
    p_mod_subnet.add_argument('--tag', action='append', default=None,
                              metavar='KEY=VALUE',
                              help='Replacement tags in key=value format (repeatable); '
                                   'replaces all existing tags when supplied')

    # ------------------------------------------------------------------
    # modify-zone
    # ------------------------------------------------------------------
    p_mod_zone = subparsers.add_parser(
        'modify-zone',
        help='Modify comment, tags, or disabled state on an existing DNS zone',
    )
    p_mod_zone.add_argument('--id', required=True, dest='zone_id',
                            help='Resource ID of the zone to modify')
    p_mod_zone.add_argument('--comment', default=None,
                            help='New comment (omit to leave unchanged)')
    p_mod_zone.add_argument('--tag', action='append', default=None,
                            metavar='KEY=VALUE',
                            help='Replacement tags in key=value format (repeatable); '
                                 'replaces all existing tags when supplied')
    p_mod_zone.add_argument('--disable', action='store_true', default=None,
                            help='Disable the zone')
    p_mod_zone.add_argument('--enable', action='store_true', default=None,
                            help='Enable (un-disable) the zone')

    # ------------------------------------------------------------------
    # modify-record
    # ------------------------------------------------------------------
    p_mod_record = subparsers.add_parser(
        'modify-record',
        help='Modify rdata, TTL, comment, tags, or disabled state on an existing DNS record',
    )
    p_mod_record.add_argument('--id', required=True, dest='record_id',
                              help='Resource ID of the record to modify')
    p_mod_record.add_argument('--rdata', default=None,
                              help='New record data in presentation format (omit to leave unchanged)')
    p_mod_record.add_argument('--ttl', type=int, default=None,
                              help='New TTL in seconds (omit to leave unchanged)')
    p_mod_record.add_argument('--comment', default=None,
                              help='New comment (omit to leave unchanged)')
    p_mod_record.add_argument('--tag', action='append', default=None,
                              metavar='KEY=VALUE',
                              help='Replacement tags in key=value format (repeatable); '
                                   'replaces all existing tags when supplied')
    p_mod_record.add_argument('--disable', action='store_true', default=None,
                              help='Disable the record')
    p_mod_record.add_argument('--enable', action='store_true', default=None,
                              help='Enable (un-disable) the record')

    # ------------------------------------------------------------------
    # delete-subnet
    # ------------------------------------------------------------------
    p_del_subnet = subparsers.add_parser(
        'delete-subnet',
        help='Delete a subnet',
    )
    p_del_subnet.add_argument('--id', required=True, dest='subnet_id',
                              help='Resource ID of the subnet to delete')
    p_del_subnet.add_argument('-y', '--yes', action='store_true',
                              help='Skip confirmation prompt')

    # ------------------------------------------------------------------
    # delete-zone
    # ------------------------------------------------------------------
    p_del_zone = subparsers.add_parser(
        'delete-zone',
        help='Delete an authoritative DNS zone',
    )
    p_del_zone.add_argument('--id', required=True, dest='zone_id',
                            help='Resource ID of the zone to delete')
    p_del_zone.add_argument('-y', '--yes', action='store_true',
                            help='Skip confirmation prompt')

    # ------------------------------------------------------------------
    # delete-record
    # ------------------------------------------------------------------
    p_del_record = subparsers.add_parser(
        'delete-record',
        help='Delete a DNS resource record',
    )
    p_del_record.add_argument('--id', required=True, dest='record_id',
                              help='Resource ID of the record to delete')
    p_del_record.add_argument('-y', '--yes', action='store_true',
                              help='Skip confirmation prompt')

    # ------------------------------------------------------------------
    # release-ip
    # ------------------------------------------------------------------
    p_rel_ip = subparsers.add_parser(
        'release-ip',
        help='Release an allocated IP address',
    )
    p_rel_ip.add_argument('--id', required=True, dest='address_id',
                          help='Resource ID of the address object to release')
    p_rel_ip.add_argument('-y', '--yes', action='store_true',
                          help='Skip confirmation prompt')

    # ------------------------------------------------------------------
    # find-networks
    # ------------------------------------------------------------------
    p_find = subparsers.add_parser(
        'find-networks',
        help='List subnets or address blocks matching a tag',
    )
    p_find.add_argument('--tag-key', required=True,
                        help='Tag key to search for')
    p_find.add_argument('--tag-value', required=True,
                        help='Tag value to search for')
    p_find.add_argument('--type', dest='network_type',
                        choices=['subnet', 'address_block'], default='subnet',
                        help='Network object type to search (default: subnet)')
    p_find.add_argument('--space', default='',
                        help='IP space resource ID (optional, narrows search)')

    # ------------------------------------------------------------------
    # list-spaces
    # ------------------------------------------------------------------
    p_spaces = subparsers.add_parser(
        'list-spaces',
        help='List IP spaces',
    )
    p_spaces.add_argument('--name', default=None, dest='name_filter',
                          help='Filter by name substring')
    p_spaces.add_argument('--tag-key', default=None,
                          help='Tag key filter')
    p_spaces.add_argument('--tag-value', default=None,
                          help='Tag value filter (requires --tag-key)')

    # ------------------------------------------------------------------
    # list-views
    # ------------------------------------------------------------------
    p_views = subparsers.add_parser(
        'list-views',
        help='List DNS views',
    )
    p_views.add_argument('--name', default=None, dest='name_filter',
                         help='Filter by name substring')
    p_views.add_argument('--tag-key', default=None,
                         help='Tag key filter')
    p_views.add_argument('--tag-value', default=None,
                         help='Tag value filter (requires --tag-key)')

    # ------------------------------------------------------------------
    # list-address-blocks
    # ------------------------------------------------------------------
    p_blocks = subparsers.add_parser(
        'list-address-blocks',
        help='List address blocks',
    )
    p_blocks.add_argument('--name', default=None, dest='name_filter',
                          help='Filter by name substring')
    p_blocks.add_argument('--tag-key', default=None,
                          help='Tag key filter')
    p_blocks.add_argument('--tag-value', default=None,
                          help='Tag value filter (requires --tag-key)')
    p_blocks.add_argument('--space', default='',
                          help='IP space resource ID (optional, narrows search)')

    # ------------------------------------------------------------------
    # provision
    # ------------------------------------------------------------------
    p_prov = subparsers.add_parser(
        'provision',
        help='Allocate a subnet and optionally create forward and/or reverse DNS zones',
    )
    p_prov.add_argument('--tag-key', required=True,
                        help='Tag key to locate the address block')
    p_prov.add_argument('--tag-value', required=True,
                        help='Tag value to locate the address block')
    p_prov.add_argument('--cidr', required=True, type=int,
                        help='Prefix length for the new subnet (e.g. 24)')
    p_prov.add_argument('--name', default='',
                        help='Name for the new subnet')
    p_prov.add_argument('--comment', default='',
                        help='Comment applied to all created objects')
    p_prov.add_argument('--forward-zone',  default='', dest='forward_zone_fqdn',
                        help='FQDN of the forward DNS zone to create (e.g. prod.example.com)')
    p_prov.add_argument('--view', default='',
                        help='DNS view resource ID (required when creating zones)')
    p_prov.add_argument('--reverse-zone', action='store_true',
                        help='Auto-create the in-addr.arpa reverse zone for the new subnet')
    p_prov.add_argument('--tag', action='append', default=[],
                        metavar='KEY=VALUE',
                        help='Tags applied to all created objects (repeatable)')
    p_prov.add_argument('--space', default='',
                        help='IP space resource ID (optional, narrows search)')

    return parser.parse_args()


def setup_logging(debug: bool = False) -> None:
    '''
    Configure root logging

    Parameters:
        debug (bool): enable debug level

    Returns:
        None
    '''
    level = logging.DEBUG if debug else logging.INFO
    logging.basicConfig(
        level=level,
        format='%(asctime)s %(levelname)s: %(message)s',
    )


def _parse_tags(raw_tags: list | None) -> Optional[dict]:
    '''
    Parse a list of "key=value" strings into a dict.

    Parameters:
        raw_tags (list | None): list of "key=value" strings, or None

    Returns:
        dict of tag key/value pairs, or None if input was None or empty
    '''
    if raw_tags is None:
        return None
    tags = {}
    for item in raw_tags:
        if '=' in item:
            key, _, value = item.partition('=')
            tags[key.strip()] = value.strip()
        else:
            logger.warning('Ignoring malformed tag (expected key=value): %s', item)
    return tags or None


def _resolve_disabled_flag(args: argparse.Namespace) -> Optional[bool]:
    '''
    Resolve mutually exclusive --disable / --enable flags to a bool or None.

    Parameters:
        args (argparse.Namespace): parsed arguments (must have disable and enable attrs)

    Returns:
        True if --disable given, False if --enable given, None if neither
    '''
    if args.disable and args.enable:
        logging.warning('Both --disable and --enable supplied; --disable takes precedence')
    if args.disable:
        return True
    if args.enable:
        return False
    return None


def _confirm_delete(resource_type: str, resource_id: str, yes: bool) -> bool:
    '''
    Prompt for confirmation before a destructive delete operation.

    Parameters:
        resource_type (str): human label for the resource being deleted
        resource_id (str): resource ID being deleted
        yes (bool): if True, skip the prompt and return True

    Returns:
        bool: True if confirmed, False if declined
    '''
    if yes:
        return True
    try:
        answer = input(f'Delete {resource_type} {resource_id}? [y/N] ').strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return answer in ('y', 'yes')


def main() -> int:
    '''
    Main entry point

    Returns:
        int: exit code (0 = success, 1 = failure)
    '''
    args = parseargs()
    setup_logging(args.debug)

    verify_ssl_override = False if args.no_verify_ssl else None
    api_key, base_url, verify_ssl = resolve_credentials(
        args.api_key, args.ini, verify_ssl_override=verify_ssl_override
    )
    if not api_key:
        logging.error(
            'No API key found. Provide via --api-key, INFOBLOX_PORTAL_KEY / '
            'UDDI_API_KEY environment variable, or [UDDI] section in %s',
            args.ini,
        )
        return 1

    client = PortalClient(api_key=api_key, base_url=base_url, verify_ssl=verify_ssl)
    formatter = Formatter(args.output)

    try:
        dry_run = args.dry_run

        if args.subcommand == 'create-subnet':
            result = portal.create_next_subnet(
                client=client,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
                cidr=args.cidr,
                name=args.name,
                comment=args.comment,
                space=args.space or None,
                dry_run=dry_run,
            )

        elif args.subcommand == 'create-zone':
            result = portal.create_dns_zone(
                client=client,
                fqdn=args.fqdn,
                view=args.view,
                primary_type=args.primary_type,
                comment=args.comment,
                tags=_parse_tags(args.tag),
                dry_run=dry_run,
            )

        elif args.subcommand == 'create-record':
            result = portal.create_dns_record(
                client=client,
                name_in_zone=args.name,
                zone_id=args.zone,
                rtype=args.rtype,
                rdata=args.rdata,
                view=args.view,
                ttl=args.ttl,
                comment=args.comment,
                tags=_parse_tags(args.tag),
                dry_run=dry_run,
            )

        elif args.subcommand == 'allocate-ip':
            result = portal.allocate_ip(
                client=client,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
                count=args.count,
                name=args.name,
                comment=args.comment,
                space=args.space or None,
                dry_run=dry_run,
            )

        elif args.subcommand == 'modify-subnet':
            result = portal.modify_subnet(
                client=client,
                subnet_id=args.subnet_id,
                name=args.name,
                comment=args.comment,
                tags=_parse_tags(args.tag) if args.tag is not None else None,
                dry_run=dry_run,
            )

        elif args.subcommand == 'modify-zone':
            result = portal.modify_dns_zone(
                client=client,
                zone_id=args.zone_id,
                comment=args.comment,
                tags=_parse_tags(args.tag) if args.tag is not None else None,
                disabled=_resolve_disabled_flag(args),
                dry_run=dry_run,
            )

        elif args.subcommand == 'modify-record':
            result = portal.modify_dns_record(
                client=client,
                record_id=args.record_id,
                rdata=args.rdata,
                ttl=args.ttl,
                comment=args.comment,
                tags=_parse_tags(args.tag) if args.tag is not None else None,
                disabled=_resolve_disabled_flag(args),
                dry_run=dry_run,
            )

        elif args.subcommand == 'delete-subnet':
            if not dry_run and not _confirm_delete('subnet', args.subnet_id, args.yes):
                print('Aborted.')
                return 0
            result = portal.delete_subnet(client=client, subnet_id=args.subnet_id, dry_run=dry_run)

        elif args.subcommand == 'delete-zone':
            if not dry_run and not _confirm_delete('DNS zone', args.zone_id, args.yes):
                print('Aborted.')
                return 0
            result = portal.delete_dns_zone(client=client, zone_id=args.zone_id, dry_run=dry_run)

        elif args.subcommand == 'delete-record':
            if not dry_run and not _confirm_delete('DNS record', args.record_id, args.yes):
                print('Aborted.')
                return 0
            result = portal.delete_dns_record(client=client, record_id=args.record_id, dry_run=dry_run)

        elif args.subcommand == 'release-ip':
            if not dry_run and not _confirm_delete('IP address', args.address_id, args.yes):
                print('Aborted.')
                return 0
            result = portal.release_ip(client=client, address_id=args.address_id, dry_run=dry_run)

        elif args.subcommand == 'find-networks':
            result = portal.find_networks_by_tag(
                client=client,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
                network_type=args.network_type,
                space=args.space or None,
            )

        elif args.subcommand == 'list-spaces':
            result = portal.list_ip_spaces(
                client=client,
                name_filter=args.name_filter,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
            )

        elif args.subcommand == 'list-views':
            result = portal.list_views(
                client=client,
                name_filter=args.name_filter,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
            )

        elif args.subcommand == 'list-address-blocks':
            result = portal.list_address_blocks(
                client=client,
                name_filter=args.name_filter,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
                space=args.space or None,
            )

        elif args.subcommand == 'provision':
            result = portal.provision(
                client=client,
                tag_key=args.tag_key,
                tag_value=args.tag_value,
                cidr=args.cidr,
                name=args.name,
                comment=args.comment,
                forward_zone_fqdn=args.forward_zone_fqdn or None,
                view_id=args.view or None,
                create_reverse_zone=args.reverse_zone,
                tags=_parse_tags(args.tag),
                space=args.space or None,
                dry_run=dry_run,
            )

        else:
            logging.error('Unknown subcommand: %s', args.subcommand)
            return 1

    except Exception as exc:
        logging.error('Operation failed: %s', exc)
        logger.debug('', exc_info=True)
        return 1

    formatter.print(result)
    return 1 if any(line.startswith('ERROR:') for line in result) else 0


if __name__ == '__main__':
    sys.exit(main())
