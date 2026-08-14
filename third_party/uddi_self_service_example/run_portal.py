#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: uddi_self_service_example.py
 Author: Chris Marrison
 Description: Runner script for uddi_self_service_example

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from uddi_self_service_example.__main__ import main

if __name__ == '__main__':
    sys.exit(main())
