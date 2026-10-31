"""Host entrypoint guard only: no Docker, SSH, or physical-gate assertion."""
from pathlib import Path
import base64
import io
import importlib.util
import json
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("ssh_host", ROOT / "tools/f0/ssh/host-run.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)

PUBLIC = b"ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32) + b" fixture\n"


def archive(name="aixle-jobs/job.meta", kind=tarfile.REGTYPE, content=b"job bytes\x00\n"):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w") as tar:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.size = len(content) if kind == tarfile.REGTYPE else 0
        entry.linkname = "/lab/client_key" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
        tar.addfile(entry, io.BytesIO(content))
    return result.getvalue()


class FixtureIOTest(unittest.TestCase):
    def test_journal_rejects_unvalidated_suffix_before_retention(self):
        valid = archive()
        invalid = [valid + archive("../outside"),
                   valid + archive("aixle-jobs/link", kind=tarfile.SYMTYPE),
                   valid + b"BEGIN OPENSSH PRIVATE KEY",
                   valid + b"x" + b"\x00" * 511,
                   valid[:-1], valid[:1024], valid[:1536]]
        for raw in invalid:
            with self.subTest(size=len(raw)), tempfile.TemporaryDirectory() as temp:
                with patch.object(host, "binary_run", return_value=raw):
                    with self.assertRaises(ValueError):
                        host.FixtureIO([]).journal("target", Path(temp), True)
                self.assertFalse((Path(temp) / "journal.tar").exists())
        # Both minimal EOF and normal tar record padding remain acceptable.
        for raw in (valid[:2048], valid, valid + b"\x00" * 512):
            host.validate_journal(raw)

    def test_exact_public_transfer_and_stdin_only(self):
        commands, calls = [], []
        fixture = host.FixtureIO(commands)
        def execute(argv, payload, limit):
            calls.append((argv, payload, limit))
            if "/bin/chmod" in argv:
                return b""
            if "/usr/bin/stat" in argv:
                return b"644\n"
            return PUBLIC
        with patch.object(host, "binary_run", side_effect=execute):
            self.assertEqual(PUBLIC, fixture.public("target", "/lab/host_key.pub"))
            fixture.write("target", "/lab/authorized_keys", PUBLIC)
        self.assertEqual([PUBLIC], [p for _, p, _ in calls if p is not None])
        self.assertTrue(all(PUBLIC.decode() not in " ".join(c) for c in commands))
        self.assertTrue(all(c[:5] == ["docker", "exec", "-i", "target", "/usr/bin/env"] for c in commands))

    def test_refuses_private_paths_sizes_and_invalid_public(self):
        fixture = host.FixtureIO([])
        with patch.object(host, "binary_run") as execute:
            for path in ("/lab/client_key", "/lab/host_key", "/lab/wrong_host", "/lab/../host_key.pub"):
                with self.assertRaises(ValueError):
                    fixture.public("target", path)
                with self.assertRaises(ValueError):
                    fixture.write("target", path, PUBLIC)
            for value in (b"", b"x" * (host.FILE_LIMIT + 1), b"-----BEGIN OPENSSH PRIVATE KEY-----", b"ssh-ed25519 eA==\n", PUBLIC + b"second line\n"):
                with self.assertRaises(ValueError):
                    fixture.write("target", "/lab/authorized_keys", value)
            for path in ("/lab/known_hosts", "/lab/wrong_hosts", "/lab/config.json", "/lab/wrong-config.json"):
                with self.assertRaises(ValueError):
                    fixture.write("target", path, b"-----BEGIN OPENSSH PRIVATE KEY-----")
            execute.assert_not_called()

    def test_known_hosts_and_fixed_config_use_stdin(self):
        config = dict(host="target", user="lab", identity_file="/lab/client_key",
                      known_hosts_file="/lab/known_hosts", lab_opt_in=True,
                      fingerprint="SHA256:" + "a" * 43)
        for path, value in (("/lab/known_hosts", b"f0-lab-pinned " + PUBLIC),
                            ("/lab/config.json", json.dumps(config).encode())):
            commands = []
            with patch.object(host, "binary_run", side_effect=[value, b"", value, b"644\n"]) as execute:
                host.FixtureIO(commands).write("central", path, value)
                self.assertEqual(value, execute.call_args_list[0].args[1])
                self.assertNotIn(value.decode(), " ".join(commands[0]))
        config["identity_file"] = "/root/.ssh/id_ed25519"
        with patch.object(host, "binary_run") as execute, self.assertRaises(ValueError):
            host.FixtureIO([]).write("central", "/lab/config.json", json.dumps(config).encode())
        execute.assert_not_called()

    def test_partial_write_and_readback_failure(self):
        for responses in ([PUBLIC[:-1]], [PUBLIC, b"", b"wrong"], [PUBLIC, b"", PUBLIC, b"666\n"]):
            with patch.object(host, "binary_run", side_effect=responses):
                with self.assertRaises(ValueError):
                    host.FixtureIO([]).write("target", "/lab/authorized_keys", PUBLIC)

    def test_binary_process_exact_bytes_failure_and_limit(self):
        value = b"\x00\xff\nquotes ' $()\n"
        self.assertEqual(value, host.binary_run(["/bin/cat"], value))
        with self.assertRaises(ValueError):
            host.binary_run(["/bin/cat"], b"x" * 10000, limit=50)
        with self.assertRaises(RuntimeError):
            host.binary_run(["/bin/false"], value)

    def test_journal_phase_and_exact_raw_retention(self):
        fixture = host.FixtureIO([])
        raw = archive()
        with tempfile.TemporaryDirectory() as temp, patch.object(host, "binary_run", return_value=raw) as execute:
            evidence = Path(temp)
            self.assertEqual("NOTRUN", fixture.journal("target", evidence, False)["status"])
            execute.assert_not_called()
            self.assertEqual("PASS", fixture.journal("target", evidence, True)["status"])
            self.assertEqual(raw, (evidence / "journal.tar").read_bytes())
            self.assertFalse((evidence / "aixle-jobs").exists())
        for raw in (archive("../escape"), archive("/aixle-jobs/file"), archive("aixle-jobs/../escape"),
                    archive("aixle-jobs/client_key"), archive(kind=tarfile.SYMTYPE),
                    archive(kind=tarfile.LNKTYPE), archive(kind=tarfile.CHRTYPE),
                    archive(kind=tarfile.DIRTYPE), b"", b"x" * (host.JOURNAL_LIMIT + 1)):
            with self.assertRaises((ValueError, tarfile.TarError)):
                host.validate_journal(raw)


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

    def test_required_journal_capture_failure_still_removes_owned_resources(self):
        for raw in (b"", archive() + archive("../outside"),
                    archive() + archive("aixle-jobs/link", kind=tarfile.SYMTYPE),
                    archive() + b"BEGIN OPENSSH PRIVATE KEY"):
            with self.subTest(size=len(raw)):
                self.assert_journal_failure_cleanup(raw)

    def assert_journal_failure_cleanup(self, raw):
        with tempfile.TemporaryDirectory() as temp:
            resources, calls = {}, []
            def execute(args, **kwargs):
                args = list(args)
                calls.append(args)
                output = b""
                if args[0] == "ip":
                    output = b"[]"
                elif "create" in args:
                    container = args[1] == "create"
                    name = args[args.index("--name") + 1] if container else args[-1]
                    data = {"Id": "id-" + name, "Labels": {"agent-control.fixture": "c" * 32},
                            "Config": {"Labels": {"agent-control.fixture": "c" * 32}},
                            "NetworkSettings": {}, "State": {}, "HostConfig": {}}
                    resources[name] = resources[data["Id"]] = data
                elif "inspect" in args:
                    output = json.dumps([resources[args[-1]]]).encode() if args[-1] in resources else b"[]"
                elif "RUBY_VERSION" in args[-1]:
                    output = b"4.0.9"
                return subprocess.CompletedProcess(args, 0, stdout=output, stderr=b"")
            with patch.object(host, "ROOT", Path(temp)), patch.object(host.secrets, "token_hex", return_value="c" * 32), patch.object(host.subprocess, "run", side_effect=execute), patch.object(host.FixtureIO, "public", return_value=PUBLIC), patch.object(host.FixtureIO, "write"), patch.object(host, "binary_run", return_value=raw) as transfer:
                self.assertNotEqual(0, host.main(["sha256:" + "a" * 64] * 2 + ["--subnet", "172.28.96.16/28"]))
            evidence = next(Path(temp).rglob("gate.json")).parent
            transfer.assert_called_once()
            self.assertEqual(["/bin/tar", "-C", "/tmp", "-cf", "-", "aixle-jobs"], transfer.call_args.args[0][-6:])
            self.assertFalse((evidence / "journal.tar").exists())
            self.assertEqual("FAIL", json.loads((evidence / "gate.json").read_text())["physical"])
            self.assertEqual("FAIL", json.loads((evidence / "journal.json").read_text())["status"])
            self.assertFalse(json.loads((evidence / "capture.json").read_text())["passed"])
            self.assertTrue(json.loads((evidence / "cleanup.json").read_text())["passed"])
            self.assertEqual(2, len([c for c in calls if c[1] == "rm"]))
            self.assertEqual(1, len([c for c in calls if c[1:3] == ["network", "rm"]]))
            self.assertTrue((evidence / "hashes.json").exists())


if __name__ == "__main__":
    unittest.main()
