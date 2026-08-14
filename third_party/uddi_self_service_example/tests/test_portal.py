#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: test_portal.py
 Author: Chris Marrison
 Description: Unit tests for portal.py

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

from unittest.mock import MagicMock, call
import pytest

from uddi_self_service_example import portal
from uddi_self_service_example.output import PortalResult, Formatter


def _make_obj(**kwargs):
    '''Return a simple object with attributes set from kwargs'''
    obj = MagicMock()
    for key, value in kwargs.items():
        setattr(obj, key, value)
    return obj


# ------------------------------------------------------------------
# Create
# ------------------------------------------------------------------

class TestCreateNextSubnet:

    def test_no_address_blocks_found(self):
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = []
        result = portal.create_next_subnet(client, 'env', 'prod', cidr=24)
        assert any('ERROR' in l for l in result)
        assert result.data == {'subnets': []}

    def test_creates_subnet_successfully(self):
        block = _make_obj(address='10.0.0.0', cidr=8, id='block-1')
        subnet = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1', name='', comment='')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [block]
        client.create_next_available_subnet.return_value = [subnet]

        result = portal.create_next_subnet(client, 'env', 'prod', cidr=24)

        client.create_next_available_subnet.assert_called_once_with('block-1', 24, name='', comment='')
        assert any('10.0.1.0/24' in l for l in result)
        assert result.data['subnets'][0]['id'] == 'subnet-1'

    def test_warns_on_multiple_blocks(self):
        block1 = _make_obj(address='10.0.0.0', cidr=8, id='block-1')
        block2 = _make_obj(address='172.16.0.0', cidr=12, id='block-2')
        subnet = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1', name='', comment='')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [block1, block2]
        client.create_next_available_subnet.return_value = [subnet]

        result = portal.create_next_subnet(client, 'env', 'prod', cidr=24)
        assert any('WARNING' in l for l in result)
        client.create_next_available_subnet.assert_called_once_with('block-1', 24, name='', comment='')

    def test_no_subnet_created_returns_error(self):
        block = _make_obj(address='10.0.0.0', cidr=8, id='block-1')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [block]
        client.create_next_available_subnet.return_value = []

        result = portal.create_next_subnet(client, 'env', 'prod', cidr=24)
        assert any('ERROR' in l for l in result)


class TestCreateDnsZone:

    def test_creates_zone(self):
        zone = _make_obj(id='zone-1', fqdn='example.com.', view='v1',
                         primary_type='cloud', comment='')
        client = MagicMock()
        client.find_auth_zones.return_value = []
        client.create_auth_zone.return_value = zone

        result = portal.create_dns_zone(client, 'example.com', view='view-1')
        assert any('example.com.' in l for l in result)
        assert result.data['zone']['id'] == 'zone-1'

    def test_warns_if_zone_already_exists(self):
        existing = _make_obj(id='zone-1', fqdn='example.com.', view='v1',
                             primary_type='cloud', comment='')
        client = MagicMock()
        client.find_auth_zones.return_value = [existing]

        result = portal.create_dns_zone(client, 'example.com', view='view-1')
        assert any('WARNING' in l for l in result)
        client.create_auth_zone.assert_not_called()

    def test_normalises_fqdn(self):
        zone = _make_obj(id='zone-1', fqdn='example.com.', view='v1',
                         primary_type='cloud', comment='')
        client = MagicMock()
        client.find_auth_zones.return_value = []
        client.create_auth_zone.return_value = zone

        portal.create_dns_zone(client, 'example.com', view='view-1')
        call_kwargs = client.create_auth_zone.call_args.kwargs
        assert call_kwargs['fqdn'].endswith('.')


class TestCreateDnsRecord:

    def test_creates_record(self):
        record = _make_obj(id='rec-1', type='A', name_in_zone='www',
                           rdata='192.0.2.1', ttl=300, comment='', zone='z1', view='v1')
        client = MagicMock()
        client.create_dns_record.return_value = record

        result = portal.create_dns_record(client, 'www', 'zone-1', 'A', '192.0.2.1', 'view-1')
        assert any('192.0.2.1' in l for l in result)
        assert result.data['record']['id'] == 'rec-1'


class TestAllocateIp:

    def test_no_subnet_found(self):
        client = MagicMock()
        client.find_subnets_by_tag.return_value = []
        result = portal.allocate_ip(client, 'env', 'prod')
        assert any('ERROR' in l for l in result)

    def test_allocates_ip(self):
        subnet = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1')
        addr = _make_obj(address='10.0.1.5', id='addr-1', name='', comment='')
        client = MagicMock()
        client.find_subnets_by_tag.return_value = [subnet]
        client.allocate_next_available_ip.return_value = [addr]

        result = portal.allocate_ip(client, 'env', 'prod')
        assert any('10.0.1.5' in l for l in result)
        assert result.data['addresses'][0]['id'] == 'addr-1'


# ------------------------------------------------------------------
# Modify
# ------------------------------------------------------------------

class TestModifySubnet:

    def test_modifies_name_and_comment(self):
        updated = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1',
                            name='new-name', comment='new-comment', tags=None)
        client = MagicMock()
        client.modify_subnet.return_value = updated

        result = portal.modify_subnet(client, 'subnet-1', name='new-name', comment='new-comment')

        client.modify_subnet.assert_called_once_with(
            'subnet-1', name='new-name', comment='new-comment', tags=None, dry_run=False
        )
        assert any('10.0.1.0/24' in l for l in result)
        assert any('new-name' in l for l in result)

    def test_only_supplied_fields_appear_in_summary(self):
        updated = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1',
                            name='x', comment='changed', tags=None)
        client = MagicMock()
        client.modify_subnet.return_value = updated

        result = portal.modify_subnet(client, 'subnet-1', comment='changed')
        assert not any(l.strip().startswith('name') for l in result)
        assert any('comment' in l for l in result)

    def test_modifies_tags(self):
        updated = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1',
                            name='', comment='', tags={'env': 'prod'})
        client = MagicMock()
        client.modify_subnet.return_value = updated

        result = portal.modify_subnet(client, 'subnet-1', tags={'env': 'prod'})
        assert any('tags' in l for l in result)


class TestModifyDnsZone:

    def test_modifies_comment(self):
        updated = _make_obj(id='zone-1', fqdn='example.com.', view='v1',
                            comment='updated comment', disabled=False, tags=None)
        client = MagicMock()
        client.modify_auth_zone.return_value = updated

        result = portal.modify_dns_zone(client, 'zone-1', comment='updated comment')

        client.modify_auth_zone.assert_called_once_with(
            'zone-1', comment='updated comment', tags=None, disabled=None, dry_run=False
        )
        assert any('example.com.' in l for l in result)
        assert any('comment' in l for l in result)

    def test_disables_zone(self):
        updated = _make_obj(id='zone-1', fqdn='example.com.', view='v1',
                            comment='', disabled=True, tags=None)
        client = MagicMock()
        client.modify_auth_zone.return_value = updated

        result = portal.modify_dns_zone(client, 'zone-1', disabled=True)
        assert any('disabled' in l for l in result)

    def test_no_changes_passed_as_none(self):
        updated = _make_obj(id='zone-1', fqdn='example.com.', view='v1',
                            comment='', disabled=False, tags=None)
        client = MagicMock()
        client.modify_auth_zone.return_value = updated

        result = portal.modify_dns_zone(client, 'zone-1')
        assert len([l for l in result if l.startswith('  ')]) == 0


class TestModifyDnsRecord:

    def test_modifies_rdata_and_ttl(self):
        updated = _make_obj(id='rec-1', name_in_zone='www', type='A',
                            rdata='192.0.2.99', ttl=600, comment='', disabled=False, tags=None)
        client = MagicMock()
        client.modify_dns_record.return_value = updated

        result = portal.modify_dns_record(client, 'rec-1', rdata='192.0.2.99', ttl=600)

        client.modify_dns_record.assert_called_once_with(
            'rec-1', rdata='192.0.2.99', ttl=600, comment=None, tags=None, disabled=None, dry_run=False
        )
        assert any('rdata' in l for l in result)
        assert any('ttl' in l for l in result)

    def test_enables_record(self):
        updated = _make_obj(id='rec-1', name_in_zone='www', type='A',
                            rdata='1.2.3.4', ttl=300, comment='', disabled=False, tags=None)
        client = MagicMock()
        client.modify_dns_record.return_value = updated

        result = portal.modify_dns_record(client, 'rec-1', disabled=False)
        assert any('disabled' in l for l in result)


# ------------------------------------------------------------------
# Find networks
# ------------------------------------------------------------------

class TestFindNetworksByTag:

    def test_finds_subnets(self):
        subnet = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1', name='test',
                           comment='', space='sp-1')
        client = MagicMock()
        client.find_subnets_by_tag.return_value = [subnet]

        result = portal.find_networks_by_tag(client, 'env', 'prod')
        assert any('10.0.1.0/24' in l for l in result)
        assert result.data['subnets'][0]['id'] == 'subnet-1'

    def test_finds_address_blocks(self):
        block = _make_obj(address='10.0.0.0', cidr=8, id='block-1', name='',
                          comment='', space='sp-1')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [block]

        result = portal.find_networks_by_tag(client, 'env', 'prod', network_type='address_block')
        assert any('10.0.0.0/8' in l for l in result)
        assert result.data['address_blocks'][0]['id'] == 'block-1'

    def test_no_results(self):
        client = MagicMock()
        client.find_subnets_by_tag.return_value = []

        result = portal.find_networks_by_tag(client, 'env', 'prod')
        assert len(result) == 1
        assert 'No subnet' in result[0]


# ------------------------------------------------------------------
# Delete / release
# ------------------------------------------------------------------

class TestDeleteSubnet:

    def test_deletes_subnet(self):
        client = MagicMock()
        result = portal.delete_subnet(client, 'subnet-1')
        client.delete_subnet.assert_called_once_with('subnet-1', dry_run=False)
        assert any('subnet-1' in l for l in result)
        assert result.data['deleted']['type'] == 'subnet'


class TestDeleteDnsZone:

    def test_deletes_zone(self):
        client = MagicMock()
        result = portal.delete_dns_zone(client, 'zone-1')
        client.delete_auth_zone.assert_called_once_with('zone-1', dry_run=False)
        assert result.data['deleted']['id'] == 'zone-1'


class TestDeleteDnsRecord:

    def test_deletes_record(self):
        client = MagicMock()
        result = portal.delete_dns_record(client, 'rec-1')
        client.delete_dns_record.assert_called_once_with('rec-1', dry_run=False)
        assert result.data['deleted']['id'] == 'rec-1'


class TestReleaseIp:

    def test_releases_address(self):
        client = MagicMock()
        result = portal.release_ip(client, 'addr-1')
        client.release_ip.assert_called_once_with('addr-1', dry_run=False)
        assert result.data['deleted']['type'] == 'address'


# ------------------------------------------------------------------
# Dry-run
# ------------------------------------------------------------------

class TestDryRunCreateSubnet:

    def test_skips_create_and_emits_dry_run_line(self):
        block = _make_obj(address='10.0.0.0', cidr=8, id='block-1')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [block]

        result = portal.create_next_subnet(client, 'env', 'prod', cidr=24, dry_run=True)

        client.create_next_available_subnet.assert_not_called()
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True
        assert result.data['subnets'] == []

    def test_no_block_found_still_errors(self):
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = []
        result = portal.create_next_subnet(client, 'env', 'prod', cidr=24, dry_run=True)
        assert any('ERROR' in l for l in result)


class TestDryRunCreateZone:

    def test_skips_create_and_emits_dry_run_line(self):
        client = MagicMock()
        client.find_auth_zones.return_value = []

        result = portal.create_dns_zone(client, 'example.com', view='view-1', dry_run=True)

        client.create_auth_zone.assert_not_called()
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True


class TestDryRunCreateRecord:

    def test_skips_create_and_emits_dry_run_line(self):
        client = MagicMock()

        result = portal.create_dns_record(
            client, 'www', 'zone-1', 'A', '192.0.2.1', 'view-1', dry_run=True
        )

        client.create_dns_record.assert_not_called()
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True


class TestDryRunAllocateIp:

    def test_skips_allocation_and_emits_dry_run_line(self):
        subnet = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1')
        client = MagicMock()
        client.find_subnets_by_tag.return_value = [subnet]

        result = portal.allocate_ip(client, 'env', 'prod', dry_run=True)

        client.allocate_next_available_ip.assert_not_called()
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True
        assert result.data['addresses'] == []


class TestDryRunModifySubnet:

    def test_reports_would_modify_without_writing(self):
        updated = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1',
                            name='new-name', comment='old', tags=None)
        client = MagicMock()
        client.modify_subnet.return_value = updated

        result = portal.modify_subnet(client, 'subnet-1', name='new-name', dry_run=True)

        client.modify_subnet.assert_called_once_with(
            'subnet-1', name='new-name', comment=None, tags=None, dry_run=True
        )
        assert any('[DRY RUN]' in l for l in result)
        assert any('(would set)' in l for l in result)
        assert result.data.get('dry_run') is True


class TestDryRunDeleteSubnet:

    def test_skips_delete_and_emits_dry_run_line(self):
        client = MagicMock()
        result = portal.delete_subnet(client, 'subnet-1', dry_run=True)
        client.delete_subnet.assert_called_once_with('subnet-1', dry_run=True)
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True

    def test_non_dry_run_omits_dry_run_marker(self):
        client = MagicMock()
        result = portal.delete_subnet(client, 'subnet-1', dry_run=False)
        assert not any('[DRY RUN]' in l for l in result)
        assert 'dry_run' not in result.data


class TestDryRunDeleteZone:

    def test_skips_delete_and_emits_dry_run_line(self):
        client = MagicMock()
        result = portal.delete_dns_zone(client, 'zone-1', dry_run=True)
        client.delete_auth_zone.assert_called_once_with('zone-1', dry_run=True)
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True


class TestDryRunReleaseIp:

    def test_skips_release_and_emits_dry_run_line(self):
        client = MagicMock()
        result = portal.release_ip(client, 'addr-1', dry_run=True)
        client.release_ip.assert_called_once_with('addr-1', dry_run=True)
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True


class TestDryRunProvision:

    def _block_client(self):
        block = _make_obj(address='10.0.0.0', cidr=8, id='block-1')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [block]
        client.find_auth_zones.return_value = []
        return client

    def test_subnet_only_skips_all_writes(self):
        client = self._block_client()
        result = portal.provision(client, 'env', 'prod', cidr=24, dry_run=True)
        client.create_next_available_subnet.assert_not_called()
        assert any('[DRY RUN]' in l for l in result)
        assert result.data.get('dry_run') is True

    def test_with_forward_zone_skips_zone_create(self):
        client = self._block_client()
        result = portal.provision(
            client, 'env', 'prod', cidr=24,
            forward_zone_fqdn='prod.example.com', view_id='view-1',
            dry_run=True,
        )
        client.create_auth_zone.assert_not_called()
        assert any('[DRY RUN]' in l for l in result)

    def test_with_reverse_zone_skips_zone_create(self):
        client = self._block_client()
        result = portal.provision(
            client, 'env', 'prod', cidr=24,
            create_reverse_zone=True, view_id='view-1',
            dry_run=True,
        )
        client.create_auth_zone.assert_not_called()
        assert any('in-addr.arpa' in l for l in result)
        assert any('[DRY RUN]' in l for l in result)


# ------------------------------------------------------------------
# Provision
# ------------------------------------------------------------------

class TestProvision:

    def _subnet_result(self):
        subnet = _make_obj(address='10.0.1.0', cidr=24, id='subnet-1', name='', comment='')
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = [
            _make_obj(address='10.0.0.0', cidr=8, id='block-1')
        ]
        client.create_next_available_subnet.return_value = [subnet]
        return client

    def test_subnet_only(self):
        client = self._subnet_result()
        result = portal.provision(client, 'env', 'prod', cidr=24)
        assert any('10.0.1.0/24' in l for l in result)
        assert 'subnet' in result.data
        assert 'forward_zone' not in result.data

    def test_with_forward_zone(self):
        client = self._subnet_result()
        zone = _make_obj(id='zone-1', fqdn='prod.example.com.', view='v1',
                         primary_type='cloud', comment='')
        client.find_auth_zones.return_value = []
        client.create_auth_zone.return_value = zone

        result = portal.provision(client, 'env', 'prod', cidr=24,
                                  forward_zone_fqdn='prod.example.com', view_id='view-1')
        assert 'forward_zone' in result.data
        assert result.data['forward_zone']['id'] == 'zone-1'

    def test_with_reverse_zone(self):
        client = self._subnet_result()
        rev_zone = _make_obj(id='rev-1', fqdn='1.0.10.in-addr.arpa.', view='v1',
                             primary_type='cloud', comment='')
        client.find_auth_zones.return_value = []
        client.create_auth_zone.return_value = rev_zone

        result = portal.provision(client, 'env', 'prod', cidr=24,
                                  create_reverse_zone=True, view_id='view-1')
        assert 'reverse_zone' in result.data
        assert 'in-addr.arpa' in result.data['reverse_zone']['fqdn']

    def test_zones_require_view_id(self):
        client = self._subnet_result()
        result = portal.provision(client, 'env', 'prod', cidr=24,
                                  forward_zone_fqdn='prod.example.com', view_id=None)
        assert any('ERROR' in l for l in result)

    def test_aborts_on_subnet_failure(self):
        client = MagicMock()
        client.find_address_blocks_by_tag.return_value = []
        result = portal.provision(client, 'env', 'prod', cidr=24,
                                  forward_zone_fqdn='prod.example.com', view_id='view-1')
        client.create_auth_zone.assert_not_called()


# ------------------------------------------------------------------
# List / view
# ------------------------------------------------------------------

class TestListIpSpaces:

    def test_lists_spaces(self):
        sp = _make_obj(id='sp-1', name='default', comment='main space')
        client = MagicMock()
        client.list_ip_spaces.return_value = [sp]

        result = portal.list_ip_spaces(client)
        assert any('default' in l for l in result)
        assert result.data['spaces'][0]['id'] == 'sp-1'

    def test_no_spaces(self):
        client = MagicMock()
        client.list_ip_spaces.return_value = []
        result = portal.list_ip_spaces(client)
        assert any('No IP spaces' in l for l in result)


class TestListViews:

    def test_lists_views(self):
        v = _make_obj(id='view-1', name='default', comment='')
        client = MagicMock()
        client.list_views.return_value = [v]

        result = portal.list_views(client)
        assert any('default' in l for l in result)
        assert result.data['views'][0]['id'] == 'view-1'

    def test_no_views(self):
        client = MagicMock()
        client.list_views.return_value = []
        result = portal.list_views(client)
        assert any('No DNS views' in l for l in result)


class TestListAddressBlocks:

    def test_lists_blocks(self):
        blk = _make_obj(id='blk-1', address='10.0.0.0', cidr=8, name='corp',
                        comment='', space='sp-1')
        client = MagicMock()
        client.list_address_blocks.return_value = [blk]

        result = portal.list_address_blocks(client)
        assert any('10.0.0.0/8' in l for l in result)
        assert result.data['address_blocks'][0]['id'] == 'blk-1'

    def test_no_blocks(self):
        client = MagicMock()
        client.list_address_blocks.return_value = []
        result = portal.list_address_blocks(client)
        assert any('No address blocks' in l for l in result)


# ------------------------------------------------------------------
# Output formatting
# ------------------------------------------------------------------

class TestPortalResult:

    def test_is_list_subclass(self):
        r = PortalResult(['line 1', 'line 2'], {'key': 'val'})
        assert list(r) == ['line 1', 'line 2']
        assert r.data == {'key': 'val'}

    def test_any_still_works(self):
        r = PortalResult(['ERROR: something bad'], {})
        assert any('ERROR' in l for l in r)


class TestFormatter:

    def test_text_format(self, capsys):
        r = PortalResult(['line 1', 'line 2'], {})
        Formatter('text').print(r)
        out = capsys.readouterr().out
        assert 'line 1' in out
        assert 'line 2' in out

    def test_json_format(self, capsys):
        import json
        r = PortalResult(['ignored'], {'subnets': [{'id': 's1', 'address': '10.0.0.0'}]})
        Formatter('json').print(r)
        out = capsys.readouterr().out
        parsed = json.loads(out)
        assert parsed['subnets'][0]['id'] == 's1'

    def test_table_format(self, capsys):
        r = PortalResult(['ignored'], {'views': [{'id': 'v1', 'name': 'default', 'comment': ''}]})
        Formatter('table').print(r)
        out = capsys.readouterr().out
        assert 'id' in out
        assert 'v1' in out
        assert 'default' in out

    def test_invalid_format_raises(self):
        with pytest.raises(ValueError):
            Formatter('xml')


# ------------------------------------------------------------------
# Reverse zone derivation
# ------------------------------------------------------------------

class TestCidrToReverseZone:

    def test_slash_24(self):
        assert portal._cidr_to_reverse_zone('10.0.1.0', 24) == '1.0.10.in-addr.arpa.'

    def test_slash_16(self):
        assert portal._cidr_to_reverse_zone('172.16.0.0', 16) == '16.172.in-addr.arpa.'

    def test_slash_8(self):
        assert portal._cidr_to_reverse_zone('10.0.0.0', 8) == '10.in-addr.arpa.'

    def test_slash_25_falls_back_to_slash_24_boundary(self):
        # /25 takes the /24 octets (prefix >= 24 branch)
        zone = portal._cidr_to_reverse_zone('192.168.1.0', 25)
        assert zone == '1.168.192.in-addr.arpa.'
