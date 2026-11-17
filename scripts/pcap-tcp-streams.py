#!/usr/bin/env python3
"""Bounded classic-PCAP IPv4/TCP reassembly. No application protocol knowledge."""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def assemble(segments, base):
    data = {}
    retransmitted = conflicts = 0
    for sequence, payload in segments:
        offset = (sequence - base) & 0xffffffff
        if offset >= 0x80000000:
            raise ValueError('TCP sequence precedes the selected stream base')
        for i, byte in enumerate(payload, offset):
            if i in data:
                retransmitted += 1
                conflicts += data[i] != byte
            else:
                data[i] = byte
    positions = sorted(data)
    contiguous = not positions or (positions[0] == 0 and positions[-1] + 1 == len(positions))
    return {'payload_hex': bytes(data[i] for i in positions).hex() if contiguous and not conflicts else None,
            'captured_payload_bytes': len(data), 'has_gaps': not contiguous,
            'retransmitted_bytes': retransmitted, 'conflicting_overlap_bytes': conflicts}


def extract(raw):
    if len(raw) > 16 * 1024 * 1024 or len(raw) < 24:
        raise ValueError('Expected a classic PCAP up to 16 MiB')
    magic = raw[:4]
    orders = {b'\xd4\xc3\xb2\xa1': '<', b'\xa1\xb2\xc3\xd4': '>',
              b'\x4d\x3c\xb2\xa1': '<', b'\xa1\xb2\x3c\x4d': '>'}
    if magic not in orders:
        raise ValueError('Unsupported PCAP format (pcapng requires explicit conversion)')
    endian = orders[magic]
    link = struct.unpack_from(endian + 'I', raw, 20)[0]
    if link not in (1, 101, 113, 0):
        raise ValueError(f'Unsupported link type: {link}')
    sessions, active = [], {}
    offset = 24
    skipped = 0
    while offset < len(raw):
        if len(raw) - offset < 16:
            raise ValueError('Truncated PCAP record header')
        _, _, captured, original = struct.unpack_from(endian + 'IIII', raw, offset)
        offset += 16
        if captured > len(raw) - offset or captured < original:
            raise ValueError('Truncated captured packet')
        frame = raw[offset:offset + captured]
        offset += captured
        start = {1: 14, 101: 0, 113: 16, 0: 4}[link]
        if link == 1 and (len(frame) < 14 or frame[12:14] != b'\x08\x00'):
            skipped += 1
            continue
        if link == 113 and (len(frame) < 16 or frame[14:16] != b'\x08\x00'):
            skipped += 1
            continue
        ip = frame[start:]
        if len(ip) < 20 or ip[0] >> 4 != 4 or ip[9] != 6:
            skipped += 1
            continue
        ihl = (ip[0] & 15) * 4
        total = int.from_bytes(ip[2:4], 'big')
        fragment = int.from_bytes(ip[6:8], 'big')
        if ihl < 20 or total > len(ip) or total < ihl + 20 or fragment & 0x3fff:
            raise ValueError('Malformed/fragmented IPv4 TCP packet is unsupported')
        tcp = ip[ihl:total]
        thl = (tcp[12] >> 4) * 4
        if thl < 20 or thl > len(tcp):
            raise ValueError('Malformed TCP header')
        sport, dport, sequence = struct.unpack_from('!HHI', tcp)
        source = ('.'.join(map(str, ip[12:16])), sport)
        target = ('.'.join(map(str, ip[16:20])), dport)
        flags = tcp[13]
        pair = tuple(sorted((source, target)))
        if flags & 2 and not flags & 16:
            existing = active.get(pair)
            if existing is None or existing['client'] != source or existing['client_base'] != (sequence + 1) & 0xffffffff:
                existing = {'client': source, 'server': target, 'client_base': (sequence + 1) & 0xffffffff,
                            'server_base': None, 'client_segments': [], 'server_segments': []}
                sessions.append(existing)
                active[pair] = existing
        session = active.get(pair)
        if session is None:
            raise ValueError('Capture starts without the initiating SYN; stream direction is unknown')
        direction = 'client' if source == session['client'] else 'server'
        if flags & 2:
            session[direction + '_base'] = (sequence + 1) & 0xffffffff
        payload = tcp[thl:]
        if payload:
            session[direction + '_segments'].append(((sequence + (1 if flags & 2 else 0)) & 0xffffffff, payload))
    result = []
    for index, session in enumerate(sessions, 1):
        item = {'session_id': index, 'client': list(session['client']), 'server': list(session['server'])}
        for direction in ('client', 'server'):
            base = session[direction + '_base']
            if base is None:
                raise ValueError('Capture lacks the TCP handshake for one direction')
            item[direction + '_to_' + ('server' if direction == 'client' else 'client')] = assemble(session[direction + '_segments'], base)
        result.append(item)
    if not result:
        raise ValueError('No TCP sessions found')
    return {'format': 'tcp-streams-v1', 'pcap_sha256': hashlib.sha256(raw).hexdigest(), 'sessions': result,
            'skipped_non_tcp_packets': skipped,
            'limitations': ['Directional streams are not application message boundaries.',
                            'IPv4 TCP only; no IP fragmentation, pcapng, VLAN or missing handshake inference.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pcap', required=True)
    args = parser.parse_args()
    print(json.dumps(extract(Path(args.pcap).read_bytes()), indent=2))
