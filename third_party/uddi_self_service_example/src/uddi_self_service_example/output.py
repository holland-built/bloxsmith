#!/usr/bin/env python3
# vim: tabstop=8 expandtab shiftwidth=4 softtabstop=4
'''
 Module: output.py
 Author: Chris Marrison
 Description: Output formatting for uddi_self_service_example

 Copyright (c) 2026 Chris Marrison / Infoblox
 SPDX-License-Identifier: BSD-2-Clause
'''

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

FORMATS = ('text', 'json', 'table')


class PortalResult(list):
    '''
    Operation result that behaves as a list of human-readable lines and also
    carries a structured data dict for JSON/table output.

    Subclasses list so all existing code that iterates or slices the returned
    lines continues to work unchanged.
    '''

    def __init__(self, lines: list[str], data: dict[str, Any] | None = None) -> None:
        '''
        Initialise result

        Parameters:
            lines (list[str]): human-readable summary lines
            data (dict): structured data for JSON/table output
        '''
        super().__init__(lines)
        self.data = data or {}


class Formatter:
    '''
    Render a PortalResult in the requested output format.
    '''

    def __init__(self, output_format: str = 'text') -> None:
        '''
        Initialise formatter

        Parameters:
            output_format (str): one of "text", "json", "table"
        '''
        if output_format not in FORMATS:
            raise ValueError(f'Unknown output format {output_format!r}; choose from {FORMATS}')
        self.output_format = output_format

    def render(self, result: PortalResult) -> str:
        '''
        Render a PortalResult as a string in the configured format.

        Parameters:
            result (PortalResult): operation result to render

        Returns:
            str: formatted output string (may be multi-line)
        '''
        if self.output_format == 'json':
            return json.dumps(result.data, indent=2, default=str)
        if self.output_format == 'table':
            return self._render_table(result.data)
        return '\n'.join(result)

    def print(self, result: PortalResult) -> None:
        '''
        Print a PortalResult to stdout in the configured format.

        Parameters:
            result (PortalResult): operation result to print
        '''
        output = self.render(result)
        if output:
            print(output)

    # ------------------------------------------------------------------
    # Internal table renderer
    # ------------------------------------------------------------------

    def _render_table(self, data: dict) -> str:
        '''
        Render the first list value found in data as an ASCII table.

        Falls back to compact JSON if no list is found.

        Parameters:
            data (dict): structured result data

        Returns:
            str: formatted table or JSON string
        '''
        rows_data = None
        for value in data.values():
            if isinstance(value, list) and value:
                rows_data = value
                break

        if not rows_data:
            return json.dumps(data, indent=2, default=str)

        if not isinstance(rows_data[0], dict):
            return '\n'.join(str(r) for r in rows_data)

        headers = list(rows_data[0].keys())
        rows = [[str(row.get(h, '')) for h in headers] for row in rows_data]

        return _ascii_table(headers, rows)


def _ascii_table(headers: list[str], rows: list[list[str]]) -> str:
    '''
    Build a simple ASCII table from headers and rows.

    Parameters:
        headers (list[str]): column header names
        rows (list[list[str]]): data rows, each a list of string values

    Returns:
        str: formatted ASCII table
    '''
    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            col_widths[i] = max(col_widths[i], len(cell))

    def fmt_row(cells):
        return '  '.join(cell.ljust(col_widths[i]) for i, cell in enumerate(cells))

    sep = '  '.join('-' * w for w in col_widths)
    lines = [fmt_row(headers), sep]
    for row in rows:
        lines.append(fmt_row(row))
    return '\n'.join(lines)
