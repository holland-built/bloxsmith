#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: config.py
 Author: Chris Marrison
 Description: Credential and configuration loading for uddi_self_service_example

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import configparser
import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = 'https://csp.infoblox.com'
DEFAULT_INI_FILE = 'uddi.ini'
INI_SECTION = 'UDDI'


def read_ini(ini_file: str) -> dict:
    '''
    Read API credentials from an ini file

    Parameters:
        ini_file (str): path to the ini credentials file

    Returns:
        dict: keys api_key, base_url, valid_cert where present; empty dict on failure
    '''
    creds = {}
    config = configparser.ConfigParser()

    try:
        files_read = config.read(ini_file)
    except configparser.Error as exc:
        logger.warning('Could not parse credentials file %s: %s', ini_file, exc)
        return creds

    if not files_read:
        logger.debug('Credentials file %s not found', ini_file)
        return creds

    if INI_SECTION not in config:
        logger.warning('No [%s] section found in %s', INI_SECTION, ini_file)
        return creds

    for key in ('api_key', 'base_url', 'valid_cert'):
        if key in config[INI_SECTION]:
            creds[key] = config[INI_SECTION][key].strip('\'"')
            logger.debug('Read %s from %s', key, ini_file)

    return creds


def resolve_credentials(api_key_flag: str, ini_file: str,
                        verify_ssl_override: bool | None = None) -> tuple[str, str, bool]:
    '''
    Resolve API key, base URL, and SSL verification flag.

    Priority order for each value:

    API key:    --api-key flag > INFOBLOX_PORTAL_KEY/UDDI_API_KEY env var > ini file
    base URL:   INFOBLOX_PORTAL_URL/BLOXONE_CSP_URL env var > ini file > default
    verify SSL: verify_ssl_override (--no-verify-ssl) > ini valid_cert > default True

    Parameters:
        api_key_flag (str): value of --api-key CLI argument (empty string if not provided)
        ini_file (str): path to ini credentials file
        verify_ssl_override (bool | None): explicit SSL flag; None means use ini/default

    Returns:
        tuple: (api_key, base_url, verify_ssl)
    '''
    # Always read the ini file — it may supply base_url or valid_cert even when
    # the API key comes from a higher-priority source.
    creds = read_ini(ini_file)

    # base_url: ini file is the baseline; env vars override it for portability.
    base_url = DEFAULT_BASE_URL
    if creds.get('base_url'):
        base_url = creds['base_url'].rstrip('/')
    portal_url_env = os.environ.get('INFOBLOX_PORTAL_URL') or os.environ.get('BLOXONE_CSP_URL')
    if portal_url_env:
        base_url = portal_url_env.rstrip('/')
        logger.debug('Using base URL from environment: %s', base_url)

    # verify_ssl: ini file sets the default; explicit override wins.
    verify_ssl = True
    if creds.get('valid_cert', '').lower() in ('false', '0', 'no'):
        verify_ssl = False
    if verify_ssl_override is not None:
        verify_ssl = verify_ssl_override
        logger.debug('SSL verification overridden to: %s', verify_ssl)

    # API key: CLI flag > env var > ini file.
    if api_key_flag:
        logger.debug('Using API key from --api-key flag')
        return api_key_flag, base_url, verify_ssl

    for env_var in ('INFOBLOX_PORTAL_KEY', 'UDDI_API_KEY'):
        env_key = os.environ.get(env_var, '')
        if env_key:
            logger.debug('Using API key from %s environment variable', env_var)
            return env_key, base_url, verify_ssl

    if creds.get('api_key'):
        logger.debug('Using API key from ini file: %s', ini_file)
        return creds['api_key'], base_url, verify_ssl

    return '', base_url, verify_ssl
