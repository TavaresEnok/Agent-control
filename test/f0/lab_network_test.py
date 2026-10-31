"""Offline, behavioral IPAM and ownership regressions; no Docker access."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/f0"))
from lab_network import cidr, preflight, Ownership


class NetworkTest(unittest.TestCase):
    def test_canonical_private_capacity(self):
        for value in (None, "", "172.28.96.1/28", "172.28.96.0/29", "10.0.0.0/16",
                      "127.0.0.0/24", "100.64.0.0/24", "8.8.8.0/24", "fc00::/24", "10.0.0.0/255.255.255.0"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                cidr(value)
        for value in ("10.0.0.0/24", "172.28.96.0/28", "192.168.2.0/27"):
            self.assertEqual(value, str(cidr(value)))

    def test_overlap_all_networks_and_routes(self):
        for subnet, routes, rejected in (("172.28.0.0/16", [], True),
                ("172.28.96.0/29", [], True), ("192.168.0.0/24", [{"dst": "172.28.96.3"}], True),
                ("192.168.0.0/24", [{"dst": "172.28.0.0/16", "table": 100}], True),
                ("192.168.0.0/24", [{"dst": "default"}, {"dst": "0.0.0.0/0"}], False)):
            calls = []
            def call(*args):
                calls.append(args)
                if args[0] == "ip":
                    return json.dumps(routes)
                if args[2] == "ls":
                    return "network-a network-b"
                return json.dumps([{"IPAM": {"Config": [{"Subnet": "fd00::/64"}]}},
                                   {"IPAM": {"Config": [{"Subnet": subnet}]}}])
            with self.subTest(subnet=subnet, routes=routes):
                if rejected:
                    with self.assertRaises(ValueError):
                        preflight("172.28.96.0/28", call)
                else:
                    self.assertEqual("172.28.96.0/28", preflight("172.28.96.0/28", call))
                self.assertTrue(all("create" not in c and "rm" not in c for c in calls))

    def test_partial_creation_and_foreign_collision(self):
        for kind in ("network", "volume", "container"):
            for label in ("ours", "foreign"):
                calls = []
                def call(*args):
                    calls.append(args)
                    if "create" in args:
                        raise subprocess.CalledProcessError(125, args)
                    if "inspect" in args:
                        return json.dumps([{"Id": "unique-id", "Name": "volume-name", "Labels": {"agent-control.fixture": label},
                                            "Config": {"Labels": {"agent-control.fixture": label}}}])
                    return ""
                owner = Ownership(call, "ours")
                with self.subTest(kind=kind, label=label):
                    with self.assertRaises(subprocess.CalledProcessError):
                        owner.create(kind, "random-name", kind, "create", "random-name")
                    if label == "ours":
                        owner.remove(kind, "random-name")
                        self.assertNotIn("random-name", calls[-1])
                    else:
                        self.assertEqual({}, owner.resources)
                        self.assertFalse(any("rm" in c for c in calls))

    def test_cleanup_refuses_changed_label(self):
        for kind in ("network", "volume", "container"):
            calls = []
            label = "ours"
            def call(*args):
                calls.append(args)
                return json.dumps([{"Id": "unique-id", "Name": "volume-name", "Labels": {"agent-control.fixture": label},
                                    "Config": {"Labels": {"agent-control.fixture": label}}}])
            owner = Ownership(call, "ours")
            owner.create(kind, "random-name", kind, "create", "random-name")
            label = "foreign"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                owner.remove(kind, "random-name")
            self.assertFalse(any("rm" in c for c in calls))


if __name__ == "__main__":
    unittest.main()
