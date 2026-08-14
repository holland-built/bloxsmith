#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: web_portal.py
 Author: Chris Marrison
 Description: Flask web interface for the Universal DDI self-service portal

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import argparse
import logging
import os
import sys

from flask import Flask, render_template, request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from uddi_self_service_example.config import resolve_credentials, DEFAULT_INI_FILE
from uddi_self_service_example.client import PortalClient
from uddi_self_service_example import portal

logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET', 'uddi-self-service-dev-key')


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _client_from_request() -> tuple:
    '''Build a PortalClient from form-supplied credentials.'''
    api_key_form = request.form.get('api_key', '').strip()
    ini_file = request.form.get('ini_file', DEFAULT_INI_FILE).strip() or DEFAULT_INI_FILE
    no_verify_ssl = request.form.get('no_verify_ssl') == 'on'
    verify_ssl_override = False if no_verify_ssl else None
    api_key, base_url, verify_ssl = resolve_credentials(
        api_key_form, ini_file, verify_ssl_override=verify_ssl_override
    )
    if not api_key:
        return None, (
            'No API key found. Enter one in the Connection Settings panel above, '
            'set the INFOBLOX_PORTAL_KEY environment variable, or add it to the ini file.'
        )
    return PortalClient(api_key=api_key, base_url=base_url, verify_ssl=verify_ssl), None


def _parse_tags_str(s: str) -> dict | None:
    '''Parse "key=val, key2=val2" string into a dict, or None if empty.'''
    if not s or not s.strip():
        return None
    tags = {}
    for item in s.split(','):
        item = item.strip()
        if '=' in item:
            k, _, v = item.partition('=')
            tags[k.strip()] = v.strip()
    return tags or None


def _dry_run() -> bool:
    return request.form.get('dry_run') == 'on'


def _disabled_field(field_name: str = 'disabled') -> bool | None:
    val = request.form.get(field_name, '')
    if val == 'true':
        return True
    if val == 'false':
        return False
    return None


def _server_has_credentials() -> bool:
    '''Check at startup whether API credentials are available from env or ini file.'''
    api_key, _, _ = resolve_credentials('', DEFAULT_INI_FILE)
    return bool(api_key)


def _result_fragment(result=None, error: str | None = None):
    has_error = bool(error) or (result is not None and any(
        l.startswith('ERROR:') for l in result
    ))
    return render_template('_result.html', result=result, error=error, has_error=has_error)


def _opts_fragment(items: list, error: str | None = None, empty_msg: str = 'No resources found'):
    '''Render a list of {id, label} dicts as <option> elements.'''
    return render_template('_opts.html', items=items, error=error, empty_msg=empty_msg)


# ------------------------------------------------------------------
# Main page
# ------------------------------------------------------------------

@app.route('/')
def index():
    has_credentials = _server_has_credentials()
    return render_template('index.html', default_ini=DEFAULT_INI_FILE,
                           has_credentials=has_credentials)


@app.route('/api/overview', methods=['POST'])
def api_overview():
    '''Return an HTML fragment summarising connected IP spaces and DNS views.'''
    client, err = _client_from_request()
    if err:
        return render_template('_overview.html', error=err, spaces=[], views=[])
    try:
        spaces = client.list_ip_spaces()
        views = client.list_views()
        return render_template('_overview.html', spaces=spaces, views=views, error=None)
    except Exception as exc:
        logger.debug('api_overview error', exc_info=True)
        return render_template('_overview.html', error=str(exc), spaces=[], views=[])


# ------------------------------------------------------------------
# View routes
# ------------------------------------------------------------------

@app.route('/ops/list-spaces', methods=['POST'])
def op_list_spaces():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.list_ip_spaces(
            client,
            name_filter=request.form.get('name_filter') or None,
            tag_key=request.form.get('tag_key') or None,
            tag_value=request.form.get('tag_value') or None,
        )
    except Exception as exc:
        logger.debug('list-spaces error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/list-views', methods=['POST'])
def op_list_views():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.list_views(
            client,
            name_filter=request.form.get('name_filter') or None,
            tag_key=request.form.get('tag_key') or None,
            tag_value=request.form.get('tag_value') or None,
        )
    except Exception as exc:
        logger.debug('list-views error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/list-blocks', methods=['POST'])
def op_list_blocks():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.list_address_blocks(
            client,
            name_filter=request.form.get('name_filter') or None,
            tag_key=request.form.get('tag_key') or None,
            tag_value=request.form.get('tag_value') or None,
            space=request.form.get('space') or None,
        )
    except Exception as exc:
        logger.debug('list-blocks error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/find-networks', methods=['POST'])
def op_find_networks():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.find_networks_by_tag(
            client,
            tag_key=request.form.get('tag_key', ''),
            tag_value=request.form.get('tag_value', ''),
            network_type=request.form.get('network_type', 'subnet'),
            space=request.form.get('space') or None,
        )
    except Exception as exc:
        logger.debug('find-networks error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/api/drilldown/space', methods=['POST'])
def api_drilldown_space():
    '''Show address blocks and subnets within an IP space.'''
    client, err = _client_from_request()
    if err:
        return f'<div class="alert alert-danger small py-2 mt-2">{err}</div>'
    space_id   = request.form.get('space_id', '').strip()
    space_name = request.form.get('space_name', space_id)
    try:
        blocks  = client.list_address_blocks(space=space_id or None)
        subnets = client.list_subnets(space=space_id or None)
        return render_template('_drilldown_space.html',
                               space_id=space_id, space_name=space_name,
                               blocks=blocks, subnets=subnets)
    except Exception as exc:
        logger.debug('drilldown/space error', exc_info=True)
        return f'<div class="alert alert-danger small py-2 mt-2">Error: {exc}</div>'


@app.route('/api/drilldown/view', methods=['POST'])
def api_drilldown_view():
    '''Show zones within a DNS view.'''
    client, err = _client_from_request()
    if err:
        return f'<div class="alert alert-danger small py-2 mt-2">{err}</div>'
    view_id   = request.form.get('view_id', '').strip()
    view_name = request.form.get('view_name', view_id)
    try:
        zones = client.find_auth_zones(view=view_id or None)
        return render_template('_drilldown_view.html',
                               view_id=view_id, view_name=view_name, zones=zones)
    except Exception as exc:
        logger.debug('drilldown/view error', exc_info=True)
        return f'<div class="alert alert-danger small py-2 mt-2">Error: {exc}</div>'


@app.route('/api/drilldown/subnet', methods=['POST'])
def api_drilldown_subnet():
    '''Show IP addresses allocated within a subnet.'''
    client, err = _client_from_request()
    if err:
        return f'<div class="alert alert-danger small py-2 mt-2">{err}</div>'
    subnet_id    = request.form.get('subnet_id', '').strip()
    subnet_label = request.form.get('subnet_label', subnet_id)
    space_id     = request.form.get('space_id', '').strip()
    space_name   = request.form.get('space_name', space_id)
    try:
        addresses = client.list_addresses(subnet_id)
        return render_template('_drilldown_subnet.html',
                               subnet_id=subnet_id, subnet_label=subnet_label,
                               space_id=space_id, space_name=space_name,
                               addresses=addresses)
    except Exception as exc:
        logger.debug('drilldown/subnet error', exc_info=True)
        return f'<div class="alert alert-danger small py-2 mt-2">Error: {exc}</div>'


@app.route('/api/drilldown/zone', methods=['POST'])
def api_drilldown_zone():
    '''Show DNS records within a zone.'''
    client, err = _client_from_request()
    if err:
        return f'<div class="alert alert-danger small py-2 mt-2">{err}</div>'
    zone_id   = request.form.get('zone_id', '').strip()
    zone_fqdn = request.form.get('zone_fqdn', zone_id)
    view_id   = request.form.get('view_id', '').strip()
    view_name = request.form.get('view_name', view_id)
    try:
        records = _fetch_records(client, zone_id)
        return render_template('_drilldown_zone.html',
                               zone_id=zone_id, zone_fqdn=zone_fqdn,
                               view_id=view_id, view_name=view_name,
                               records=records, action_error=None)
    except Exception as exc:
        logger.debug('drilldown/zone error', exc_info=True)
        return f'<div class="alert alert-danger small py-2 mt-2">Error: {exc}</div>'


# ── Inline modify / delete (action + refreshed drilldown in one step) ──

def _fetch_records(client, zone_id):
    '''Serialise Record SDK objects to plain dicts for template rendering.'''
    raw = client.find_dns_records(zone_id)
    return [{
        'id':           getattr(r, 'id', ''),
        'name_in_zone': getattr(r, 'name_in_zone', '') or '@',
        'type':         getattr(r, 'type', '') or '',
        'ttl':          getattr(r, 'ttl', None),
        'dns_rdata':    getattr(r, 'dns_rdata', '') or '',
        'comment':      getattr(r, 'comment', '') or '',
        'disabled':     getattr(r, 'disabled', False) or False,
    } for r in raw]


@app.route('/api/inline/modify-subnet', methods=['POST'])
def api_inline_modify_subnet():
    client, err = _client_from_request()
    action_error = err
    space_id   = request.form.get('space_id', '').strip()
    space_name = request.form.get('space_name', space_id)
    if client and not err:
        try:
            portal.modify_subnet(
                client,
                subnet_id=request.form.get('subnet_id', '').strip(),
                name=request.form.get('name', '').strip() or None,
                comment=request.form.get('comment', '').strip() or None,
                tags=_parse_tags_str(request.form.get('tags', '')),
            )
        except Exception as exc:
            logger.debug('inline/modify-subnet error', exc_info=True)
            action_error = str(exc)
    blocks, subnets = [], []
    if client:
        try:
            blocks  = client.list_address_blocks(space=space_id or None)
            subnets = client.list_subnets(space=space_id or None)
        except Exception:
            pass
    return render_template('_drilldown_space.html',
                           space_id=space_id, space_name=space_name,
                           blocks=blocks, subnets=subnets, action_error=action_error)


@app.route('/api/inline/delete-subnet', methods=['POST'])
def api_inline_delete_subnet():
    client, err = _client_from_request()
    action_error = err
    space_id   = request.form.get('space_id', '').strip()
    space_name = request.form.get('space_name', space_id)
    if client and not err:
        try:
            client.delete_subnet(request.form.get('subnet_id', '').strip())
        except Exception as exc:
            logger.debug('inline/delete-subnet error', exc_info=True)
            action_error = str(exc)
    blocks, subnets = [], []
    if client:
        try:
            blocks  = client.list_address_blocks(space=space_id or None)
            subnets = client.list_subnets(space=space_id or None)
        except Exception:
            pass
    return render_template('_drilldown_space.html',
                           space_id=space_id, space_name=space_name,
                           blocks=blocks, subnets=subnets, action_error=action_error)


@app.route('/api/inline/modify-zone', methods=['POST'])
def api_inline_modify_zone():
    client, err = _client_from_request()
    action_error = err
    view_id   = request.form.get('view_id', '').strip()
    view_name = request.form.get('view_name', view_id)
    if client and not err:
        try:
            portal.modify_dns_zone(
                client,
                zone_id=request.form.get('zone_id', '').strip(),
                comment=request.form.get('comment', '').strip() or None,
                tags=_parse_tags_str(request.form.get('tags', '')),
                disabled=_disabled_field('disabled'),
            )
        except Exception as exc:
            logger.debug('inline/modify-zone error', exc_info=True)
            action_error = str(exc)
    zones = []
    if client:
        try:
            zones = client.find_auth_zones(view=view_id or None)
        except Exception:
            pass
    return render_template('_drilldown_view.html',
                           view_id=view_id, view_name=view_name,
                           zones=zones, action_error=action_error)


@app.route('/api/inline/delete-zone', methods=['POST'])
def api_inline_delete_zone():
    client, err = _client_from_request()
    action_error = err
    view_id   = request.form.get('view_id', '').strip()
    view_name = request.form.get('view_name', view_id)
    if client and not err:
        try:
            client.delete_auth_zone(request.form.get('zone_id', '').strip())
        except Exception as exc:
            logger.debug('inline/delete-zone error', exc_info=True)
            action_error = str(exc)
    zones = []
    if client:
        try:
            zones = client.find_auth_zones(view=view_id or None)
        except Exception:
            pass
    return render_template('_drilldown_view.html',
                           view_id=view_id, view_name=view_name,
                           zones=zones, action_error=action_error)


@app.route('/api/inline/modify-record', methods=['POST'])
def api_inline_modify_record():
    client, err = _client_from_request()
    action_error = err
    zone_id   = request.form.get('zone_id', '').strip()
    zone_fqdn = request.form.get('zone_fqdn', zone_id)
    view_id   = request.form.get('view_id', '').strip()
    view_name = request.form.get('view_name', view_id)
    if client and not err:
        ttl_str = request.form.get('ttl', '').strip()
        try:
            portal.modify_dns_record(
                client,
                record_id=request.form.get('record_id', '').strip(),
                rdata=request.form.get('rdata', '').strip() or None,
                ttl=int(ttl_str) if ttl_str else None,
                comment=request.form.get('comment', '').strip() or None,
                tags=_parse_tags_str(request.form.get('tags', '')),
                disabled=_disabled_field('disabled'),
            )
        except Exception as exc:
            logger.debug('inline/modify-record error', exc_info=True)
            action_error = str(exc)
    records = []
    if client:
        try:
            records = _fetch_records(client, zone_id)
        except Exception:
            pass
    return render_template('_drilldown_zone.html',
                           zone_id=zone_id, zone_fqdn=zone_fqdn,
                           view_id=view_id, view_name=view_name,
                           records=records, action_error=action_error)


@app.route('/api/inline/delete-record', methods=['POST'])
def api_inline_delete_record():
    client, err = _client_from_request()
    action_error = err
    zone_id   = request.form.get('zone_id', '').strip()
    zone_fqdn = request.form.get('zone_fqdn', zone_id)
    view_id   = request.form.get('view_id', '').strip()
    view_name = request.form.get('view_name', view_id)
    if client and not err:
        try:
            client.delete_dns_record(request.form.get('record_id', '').strip())
        except Exception as exc:
            logger.debug('inline/delete-record error', exc_info=True)
            action_error = str(exc)
    records = []
    if client:
        try:
            records = _fetch_records(client, zone_id)
        except Exception:
            pass
    return render_template('_drilldown_zone.html',
                           zone_id=zone_id, zone_fqdn=zone_fqdn,
                           view_id=view_id, view_name=view_name,
                           records=records, action_error=action_error)


@app.route('/api/inline/release-address', methods=['POST'])
def api_inline_release_address():
    client, err = _client_from_request()
    action_error = err
    subnet_id    = request.form.get('subnet_id', '').strip()
    subnet_label = request.form.get('subnet_label', subnet_id)
    space_id     = request.form.get('space_id', '').strip()
    space_name   = request.form.get('space_name', space_id)
    if client and not err:
        try:
            client.release_ip(request.form.get('address_id', '').strip())
        except Exception as exc:
            logger.debug('inline/release-address error', exc_info=True)
            action_error = str(exc)
    addresses = []
    if client:
        try:
            addresses = client.list_addresses(subnet_id)
        except Exception:
            pass
    return render_template('_drilldown_subnet.html',
                           subnet_id=subnet_id, subnet_label=subnet_label,
                           space_id=space_id, space_name=space_name,
                           addresses=addresses, action_error=action_error)


@app.route('/ops/list-zone-records', methods=['POST'])
def op_list_zone_records():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    zone_id = request.form.get('zone_id', '').strip()
    if not zone_id:
        return _result_fragment(error='Please select a zone first')
    try:
        result = portal.list_zone_records(
            client,
            zone_id=zone_id,
            rtype=request.form.get('rtype_filter') or None,
            name_filter=request.form.get('name_filter') or None,
        )
    except Exception as exc:
        logger.debug('list-zone-records error', exc_info=True)
        return _result_fragment(error=str(exc))
    records = result.data.get('records', [])
    if not records:
        return _result_fragment(result)
    return render_template('_records_table.html', records=records)


# ------------------------------------------------------------------
# Create routes
# ------------------------------------------------------------------

@app.route('/ops/create-subnet', methods=['POST'])
def op_create_subnet():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.create_next_subnet(
            client,
            tag_key=request.form.get('tag_key', ''),
            tag_value=request.form.get('tag_value', ''),
            cidr=int(request.form.get('cidr', 24)),
            name=request.form.get('name', ''),
            comment=request.form.get('comment', ''),
            space=request.form.get('space') or None,
            block_id=request.form.get('block_id') or None,
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('create-subnet error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/create-zone', methods=['POST'])
def op_create_zone():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.create_dns_zone(
            client,
            fqdn=request.form.get('fqdn', ''),
            view=request.form.get('view', ''),
            primary_type=request.form.get('primary_type', 'cloud'),
            comment=request.form.get('comment', ''),
            tags=_parse_tags_str(request.form.get('tags', '')),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('create-zone error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/create-record', methods=['POST'])
def op_create_record():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        ttl_str = request.form.get('ttl', '').strip()
        result = portal.create_dns_record(
            client,
            name_in_zone=request.form.get('name', ''),
            zone_id=request.form.get('zone', ''),
            rtype=request.form.get('rtype', 'A'),
            rdata=request.form.get('rdata', ''),
            view=request.form.get('view', ''),
            ttl=int(ttl_str) if ttl_str else None,
            comment=request.form.get('comment', ''),
            tags=_parse_tags_str(request.form.get('tags', '')),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('create-record error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/allocate-ip', methods=['POST'])
def op_allocate_ip():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.allocate_ip(
            client,
            tag_key=request.form.get('tag_key', ''),
            tag_value=request.form.get('tag_value', ''),
            count=int(request.form.get('count', 1) or 1),
            name=request.form.get('name', ''),
            comment=request.form.get('comment', ''),
            space=request.form.get('space') or None,
            subnet_id=request.form.get('subnet_id_direct') or None,
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('allocate-ip error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


# ------------------------------------------------------------------
# Modify routes
# ------------------------------------------------------------------

@app.route('/ops/modify-subnet', methods=['POST'])
def op_modify_subnet():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.modify_subnet(
            client,
            subnet_id=request.form.get('subnet_id', ''),
            name=request.form.get('name') or None,
            comment=request.form.get('comment') or None,
            tags=_parse_tags_str(request.form.get('tags', '')),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('modify-subnet error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/modify-zone', methods=['POST'])
def op_modify_zone():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.modify_dns_zone(
            client,
            zone_id=request.form.get('zone_id', ''),
            comment=request.form.get('comment') or None,
            tags=_parse_tags_str(request.form.get('tags', '')),
            disabled=_disabled_field(),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('modify-zone error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/modify-record', methods=['POST'])
def op_modify_record():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        ttl_str = request.form.get('ttl', '').strip()
        result = portal.modify_dns_record(
            client,
            record_id=request.form.get('record_id', ''),
            rdata=request.form.get('rdata') or None,
            ttl=int(ttl_str) if ttl_str else None,
            comment=request.form.get('comment') or None,
            tags=_parse_tags_str(request.form.get('tags', '')),
            disabled=_disabled_field(),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('modify-record error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


# ------------------------------------------------------------------
# Delete / release routes
# ------------------------------------------------------------------

@app.route('/ops/delete-subnet', methods=['POST'])
def op_delete_subnet():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.delete_subnet(
            client,
            subnet_id=request.form.get('subnet_id', ''),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('delete-subnet error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/delete-zone', methods=['POST'])
def op_delete_zone():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.delete_dns_zone(
            client,
            zone_id=request.form.get('zone_id', ''),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('delete-zone error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/delete-record', methods=['POST'])
def op_delete_record():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.delete_dns_record(
            client,
            record_id=request.form.get('record_id', ''),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('delete-record error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


@app.route('/ops/release-ip', methods=['POST'])
def op_release_ip():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.release_ip(
            client,
            address_id=request.form.get('address_id', ''),
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('release-ip error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


# ------------------------------------------------------------------
# Resource-options routes (return <option> HTML fragments for selects)
# ------------------------------------------------------------------

@app.route('/api/opts/ip-spaces', methods=['POST'])
def api_opts_ip_spaces():
    client, err = _client_from_request()
    if err:
        return _opts_fragment([], error='Credentials not configured')
    try:
        spaces = client.list_ip_spaces()
        items = [
            {'id': getattr(s, 'id', ''),
             'label': getattr(s, 'name', '') or getattr(s, 'id', '')}
            for s in spaces
        ]
        return _opts_fragment(items, empty_msg='No IP spaces found')
    except Exception as exc:
        logger.debug('api_opts_ip_spaces error', exc_info=True)
        return _opts_fragment([], error=str(exc))


@app.route('/api/opts/views', methods=['POST'])
def api_opts_views():
    client, err = _client_from_request()
    if err:
        return _opts_fragment([], error='Credentials not configured')
    try:
        views = client.list_views()
        items = [
            {'id': getattr(v, 'id', ''),
             'label': getattr(v, 'name', '') or getattr(v, 'id', '')}
            for v in views
        ]
        return _opts_fragment(items, empty_msg='No DNS views found')
    except Exception as exc:
        logger.debug('api_opts_views error', exc_info=True)
        return _opts_fragment([], error=str(exc))


@app.route('/api/opts/zones', methods=['POST'])
def api_opts_zones():
    client, err = _client_from_request()
    if err:
        return _opts_fragment([], error='Credentials not configured')
    # Accept view_id from filter selects, or 'view' from op form selects (Create Record)
    view_id = (request.form.get('view_id') or request.form.get('view') or '').strip()
    try:
        zones = client.find_auth_zones(view=view_id or None)
        items = [
            {'id': getattr(z, 'id', ''),
             'label': getattr(z, 'fqdn', '') or getattr(z, 'id', '')}
            for z in zones
        ]
        return _opts_fragment(items, empty_msg='No DNS zones found')
    except Exception as exc:
        logger.debug('api_opts_zones error', exc_info=True)
        return _opts_fragment([], error=str(exc))


@app.route('/api/opts/address-blocks', methods=['POST'])
def api_opts_address_blocks():
    client, err = _client_from_request()
    if err:
        return _opts_fragment([], error='Credentials not configured')
    space = request.form.get('space', '').strip()
    try:
        blocks = client.list_address_blocks(space=space or None)
        items = []
        for b in blocks:
            addr = getattr(b, 'address', '?')
            cidr = getattr(b, 'cidr', '?')
            name = getattr(b, 'name', '') or ''
            label = f'{addr}/{cidr}' + (f'  {name}' if name else '')
            items.append({'id': getattr(b, 'id', ''), 'label': label})
        return _opts_fragment(items, empty_msg='No address blocks found')
    except Exception as exc:
        logger.debug('api_opts_address_blocks error', exc_info=True)
        return _opts_fragment([], error=str(exc))


@app.route('/api/opts/subnets', methods=['POST'])
def api_opts_subnets():
    client, err = _client_from_request()
    if err:
        return _opts_fragment([], error='Credentials not configured')
    space = request.form.get('space', '').strip()
    block_id = request.form.get('block_id', '').strip()
    try:
        subnets = client.list_subnets(
            space=space or None,
            parent=block_id or None,
        )
        items = []
        for s in subnets:
            addr = getattr(s, 'address', '?')
            cidr = getattr(s, 'cidr', '?')
            name = getattr(s, 'name', '') or ''
            label = f'{addr}/{cidr}' + (f'  {name}' if name else '')
            items.append({'id': getattr(s, 'id', ''), 'label': label})
        return _opts_fragment(items, empty_msg='No subnets found')
    except Exception as exc:
        logger.debug('api_opts_subnets error', exc_info=True)
        return _opts_fragment([], error=str(exc))


@app.route('/api/opts/records', methods=['POST'])
def api_opts_records():
    client, err = _client_from_request()
    if err:
        return _opts_fragment([], error='Credentials not configured')
    zone_id = request.form.get('zone_lookup', '').strip()
    if not zone_id:
        return _opts_fragment([], empty_msg='Select a zone first')
    try:
        records = client.find_dns_records(zone_id)
        items = []
        for r in records:
            name = getattr(r, 'name_in_zone', '') or ''
            rtype = getattr(r, 'type', '') or ''
            # dns_rdata is the read-only text representation; rdata is a dict
            rdata_text = getattr(r, 'dns_rdata', '') or ''
            label = f'{name} {rtype} → {rdata_text}'.strip()
            items.append({'id': getattr(r, 'id', ''), 'label': label})
        return _opts_fragment(items, empty_msg='No records found in this zone')
    except Exception as exc:
        logger.debug('api_opts_records error', exc_info=True)
        return _opts_fragment([], error=str(exc))


# ------------------------------------------------------------------
# Provision route
# ------------------------------------------------------------------

@app.route('/ops/provision', methods=['POST'])
def op_provision():
    client, err = _client_from_request()
    if err:
        return _result_fragment(error=err)
    try:
        result = portal.provision(
            client,
            tag_key=request.form.get('tag_key', ''),
            tag_value=request.form.get('tag_value', ''),
            cidr=int(request.form.get('cidr', 24)),
            name=request.form.get('name', ''),
            comment=request.form.get('comment', ''),
            forward_zone_fqdn=request.form.get('forward_zone_fqdn') or None,
            view_id=request.form.get('view_id') or None,
            create_reverse_zone=request.form.get('reverse_zone') == 'on',
            tags=_parse_tags_str(request.form.get('tags', '')),
            space=request.form.get('space') or None,
            dry_run=_dry_run(),
        )
    except Exception as exc:
        logger.debug('provision error', exc_info=True)
        return _result_fragment(error=str(exc))
    return _result_fragment(result)


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

def setup_logging(debug: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format='%(asctime)s %(levelname)s: %(message)s',
    )


def parseargs() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Universal DDI self-service web portal')
    parser.add_argument('-p', '--port', type=int, default=5000,
                        help='Port to listen on (default: 5000)')
    parser.add_argument('--host', default='127.0.0.1',
                        help='Host to bind to (default: 127.0.0.1)')
    parser.add_argument('-d', '--debug', action='store_true',
                        help='Enable Flask debug mode and verbose logging')
    return parser.parse_args()


def main() -> None:
    args = parseargs()
    setup_logging(args.debug)
    logger.info('Starting web portal on http://%s:%d', args.host, args.port)
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == '__main__':
    main()
