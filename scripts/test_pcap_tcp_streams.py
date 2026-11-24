import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tcp_streams', Path(__file__).with_name('pcap-tcp-streams.py'))
streams = importlib.util.module_from_spec(spec)
spec.loader.exec_module(streams)


class StreamTests(unittest.TestCase):
    def test_public_capture_has_five_bidirectional_application_streams(self):
        raw = (Path(__file__).parent.parent / 'practice/n06/normal-sessions.pcap').read_bytes()
        result = streams.extract(raw)
        self.assertEqual(len(result['sessions']), 5)
        first = result['sessions'][0]
        self.assertEqual(first['client_to_server']['payload_hex'], '424201010006000100020003')
        self.assertEqual(first['server_to_client']['payload_hex'], '42420181000400000006')
        self.assertTrue(all(not s[d]['has_gaps'] and not s[d]['conflicting_overlap_bytes']
                            for s in result['sessions'] for d in ('client_to_server', 'server_to_client')))

    def test_out_of_order_segments_and_retransmissions_do_not_duplicate_bytes(self):
        result = streams.assemble([(103, b'def'), (100, b'abc'), (102, b'cde')], 100)
        self.assertEqual(result['payload_hex'], b'abcdef'.hex())
        self.assertEqual(result['retransmitted_bytes'], 3)
        self.assertEqual(result['conflicting_overlap_bytes'], 0)

    def test_gaps_and_conflicting_overlaps_are_not_fabricated_into_complete_streams(self):
        gap = streams.assemble([(100, b'a'), (102, b'c')], 100)
        conflict = streams.assemble([(100, b'ab'), (101, b'X')], 100)
        self.assertIsNone(gap['payload_hex'])
        self.assertTrue(gap['has_gaps'])
        self.assertIsNone(conflict['payload_hex'])
        self.assertEqual(conflict['conflicting_overlap_bytes'], 1)

    def test_sequence_wrap_and_malformed_capture(self):
        result = streams.assemble([(0xfffffffe, b'ab'), (0, b'cd')], 0xfffffffe)
        self.assertEqual(result['payload_hex'], b'abcd'.hex())
        raw = (Path(__file__).parent.parent / 'practice/n06/normal-sessions.pcap').read_bytes()
        with self.assertRaises(ValueError):
            streams.extract(raw[:-1])
        with self.assertRaises(ValueError):
            streams.extract(b'not a PCAP')


if __name__ == '__main__':
    unittest.main()
