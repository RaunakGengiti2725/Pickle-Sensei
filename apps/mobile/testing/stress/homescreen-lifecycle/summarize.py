#!/usr/bin/env python3
"""Summarize a homescreen-lifecycle stress report (seed → outcome table)."""
import collections
import json
import re
import sys

path = sys.argv[1]
verbose = len(sys.argv) > 2 and sys.argv[2] == '-v'
r = json.load(open(path))
print('iterations', r['iterations'], 'passed', r['passed'], 'failed', r['failed'])
print('failingSeeds', r['failingSeeds'])
print('violationsByInvariant', r['violationsByInvariant'])
print('wallMs', r['wallMs'], 'requests', r['totalRequests'], 'statements', r['totalStatements'],
      'kills', r['totalKills'], 'processes', r['totalProcesses'], 'rotations', r['totalRotations'])
print('stepKinds', r['stepKinds'])
notes = collections.Counter()
screens = collections.Counter()
eff = collections.Counter()
starts = collections.Counter()
finals = collections.Counter()
for row in r['rows']:
    starts[row['world']['start']] += 1
    finals[(row['observed']['final']['screen'], (row['observed']['finalSession'] or 'none')[:8])] += 1
    for t in row['trace']:
        if not t[0].isdigit():
            continue
        m = re.search(r'\[(.*?)\]', t)
        kind = t.split(' ')[1].split('(')[0]
        if m:
            notes[(kind, m.group(1))] += 1
        else:
            eff[kind] += 1
        s = re.search(r'screen=(\S+)', t)
        if s:
            screens[s.group(1)] += 1
    if verbose or row['outcome'] == 'fail':
        o = row['observed']
        print('---- SEED', row['seed'], row['outcome'], row['world'])
        print('\n'.join(row['trace']))
        print('violations', row['violations'])
        print('final', o['final'], 'reference', o['reference'])
        print('pendingAtSettle', o['pendingAtSettle'], 'consoleErrors', o['consoleErrors'], 'wallMs', o['wallMs'])
print('starts', dict(starts))
print('finals', {f'{k[0]}/{k[1]}': v for k, v in finals.items()})
print('effective steps', dict(eff))
print('inert steps', {f'{k[0]}[{k[1]}]': v for k, v in notes.items()})
print('screen at step', dict(screens))
