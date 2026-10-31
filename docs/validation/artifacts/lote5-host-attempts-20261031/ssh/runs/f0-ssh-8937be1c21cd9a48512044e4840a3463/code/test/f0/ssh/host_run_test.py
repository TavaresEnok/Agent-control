"""Host entrypoint guard only: no Docker, SSH, or physical-gate assertion."""
from pathlib import Path
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("ssh_host", ROOT / "tools/f0/ssh/host-run.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class HostRunGuardTest(unittest.TestCase):
    def test_requires_two_immutable_image_ids_before_any_resource_creation(self):
        for args in [[], ["image:latest", "target:latest"], ["sha256:" + "a" * 64],
                     ["sha256:" + "a" * 64, "--privileged"]]:
            with self.subTest(args=args):
                result = subprocess.run(
                    [sys.executable, str(ROOT / "tools/f0/ssh/host-run.py"), *args],
                    capture_output=True, text=True, timeout=5)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("Usage:", result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def test_ipam_overlap_before_any_mutation(self):
        calls = []
        def execute(args, **kwargs):
            calls.append(args)
            if "ls" in args:
                output = "allocated"
            else:
                output = json.dumps([{"IPAM": {"Config": [{"Subnet": "172.28.96.0/24"}]}}])
            return subprocess.CompletedProcess(args, 0, stdout=output.encode(), stderr=b"")
        with patch.object(host.subprocess, "run", side_effect=execute):
            with self.assertRaises(ValueError):
                host.main(["sha256:" + "a" * 64] * 2 + ["--subnet", "172.28.96.16/28"])
        self.assertEqual(2, len(calls))
        self.assertTrue(all("create" not in c for c in calls))

    def test_failures_retain_before_cleanup_with_label_verified_ownership(self):
        for failure in ("network-partial", "container-partial", "container-foreign", "start"):
            for compat in (False, True):
                with self.subTest(failure=failure, compat=compat), tempfile.TemporaryDirectory() as temp:
                    resources, calls = {}, []
                    def execute(args, **kwargs):
                        args = list(args)
                        calls.append(args)
                        output, code = b"", 0
                        if args[0] == "ip":
                            output = b'[]'
                        elif args[1:3] == ["network", "ls"]:
                            output = b''
                        elif args[1:3] == ["image", "inspect"]:
                            output = b'[]'
                        elif "inspect" in args:
                            data = resources.get(args[-1])
                            code = 0 if data else 1
                            output = json.dumps([data]).encode()
                        elif "create" in args:
                            container = args[1] == "create"
                            name = args[args.index("--name") + 1] if container else args[-1]
                            label = "foreign" if container and failure == "container-foreign" else "c" * 32
                            data = {"Id": "id-" + name, "Labels": {"agent-control.fixture": label},
                                    "Config": {"Labels": {"agent-control.fixture": label}, "Env": ["SIGNING_KEY=secret"]},
                                    "NetworkSettings": {}, "State": {}, "HostConfig": {"SecurityOpt": ["seccomp=unconfined"] if compat else []}}
                            resources[name] = resources[data["Id"]] = data
                            if failure == "network-partial" and not container or container and failure.startswith("container-"):
                                code = 125
                        elif args[1] == "start":
                            code = 125
                        elif args[1] == "logs":
                            output = b"synthetic diagnostic"
                        elif args[1] == "rm" or args[1:3] == ["network", "rm"]:
                            # Receipt and sanitized runtime must precede removal.
                            gate = next(Path(temp).rglob("gate.json"))
                            self.assertTrue(json.loads(gate.read_text())["resources"])
                        result = subprocess.CompletedProcess(args, code, stdout=output, stderr=b"")
                        if kwargs.get("check"):
                            result.check_returncode()
                        return result
                    with patch.object(host, "ROOT", Path(temp)), patch.object(host.secrets, "token_hex", return_value="c" * 32), patch.object(host.subprocess, "run", side_effect=execute):
                        with self.assertRaises(subprocess.CalledProcessError):
                            host.main(["sha256:" + "a" * 64] * 2 + ["--subnet", "172.28.96.16/28"] + (["--seccomp-compat"] if compat else []))
                    gate_path = next(Path(temp).rglob("gate.json"))
                    gate = json.loads(gate_path.read_text())
                    self.assertEqual("FAIL", gate["physical"])
                    self.assertEqual("unconfined" if compat else "docker-default", gate["seccomp"])
                    self.assertEqual("172.28.96.16/28", gate["subnet"])
                    self.assertTrue(json.loads((gate_path.parent / "cleanup.json").read_text())["passed"])
                    self.assertNotIn("SIGNING_KEY", "".join(p.read_text() for p in gate_path.parent.rglob("*") if p.is_file()))
                    creates = [c for c in calls if c[1] == "create"]
                    for create in creates:
                        self.assertIn("--pull=never", create)
                        self.assertIn("no-new-privileges:true", create)
                        self.assertEqual(compat, "seccomp=unconfined" in create)
                        for limit in ("--memory", "--cpus", "--pids-limit"):
                            self.assertIn(limit, create)
                        self.assertFalse(any(x in create for x in ("-p", "--publish", "--privileged")))
                    removed_containers = [c for c in calls if c[1] == "rm"]
                    self.assertEqual(0 if failure in ("network-partial", "container-foreign") else 1, len(removed_containers))
                    self.assertTrue(all(c[-1].startswith("id-") for c in removed_containers))


if __name__ == "__main__":
    unittest.main()
