"""Offline checks of the administrative lifecycle, not Rails authorization tests."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("access_host", Path(__file__).resolve().parents[3] / "tools/f0/access/host.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class HostTest(unittest.TestCase):
    def test_context_uses_actual_controllers_and_rejects_secret_paths(self):
        names = {name for name, _ in host.source_paths()}
        self.assertIn("app/controllers/mcp_controller.rb", names)
        self.assertIn("app/controllers/concerns/auth_concern.rb", names)
        self.assertIn("docker/traefik/dynamic.yml", names)
        self.assertIn("Gemfile.lock", names)
        self.assertIn("tools/f0/access/mcp_evidence.rb", names)
        self.assertIn("test/f0/access/mcp_evidence_test.rb", names)
        self.assertIn("tools/f0/access/session_cookie.rb", names)
        self.assertIn("test/f0/access/session_cookie_test.rb", names)
        self.assertFalse(any(Path(n).name.startswith(".env") or n.endswith((".key", ".enc", ".pem")) for n in names))
        self.assertNotIn("test/test_helper.rb", names)
        self.assertFalse(any("artifacts/" in n for n in names))

    def test_mutable_image_rejected_before_docker(self):
        with patch.object(host, "command") as execute:
            with self.assertRaises(ValueError):
                host.immutable("postgres:latest")
            execute.assert_not_called()

    def exercise_lifecycle(self, fail_boot=False, fail_start=False, fail_create=False):
        calls = []
        digest = "sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as temporary:
            def fake_command(argv, **kwargs):
                calls.append(argv)
                words = argv[1:]
                output = b""
                if words[0] in {"network", "volume", "container"} and words[1] == "inspect":
                    raise subprocess.CalledProcessError(1, argv)
                if (words[0] == "start" and fail_start) or (words[0] == "create" and fail_create):
                    raise subprocess.CalledProcessError(125, argv)
                if words[0] == "logs":
                    output = b"synthetic start diagnostic\n"
                if words[:2] == ["exec", "f0-access-" + "b" * 24 + "-web"] and "test" in words and fail_boot:
                    raise subprocess.CalledProcessError(1, argv)
                if words[:2] == ["inspect", "--format"]:
                    output = b"false" if fail_boot else b"true"
                elif words[0] == "inspect":
                    output = json.dumps([{"NetworkSettings": {}, "State": {}, "HostConfig": {
                        "Memory": 1, "NanoCpus": 1, "PidsLimit": 1, "PortBindings": {}}}]).encode()
                elif words[0] == "wait":
                    output = b"1"  # Negative security findings must propagate.
                elif words[0] == "cp":
                    Path(words[-1]).write_text('{"status":"FAIL_OR_NOTRUN"}')
                return subprocess.CompletedProcess(argv, 0, stdout=output, stderr=b"")

            with patch.object(host, "ROOT", Path(temporary)), patch.object(host, "command", side_effect=fake_command), patch.object(host.secrets, "token_hex", return_value="b" * 24):
                self.assertEqual(1, host.run(digest, digest))
            receipt_path = next(Path(temporary).rglob("receipt.json"))
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual("NOTRUN" if fail_boot or fail_start or fail_create else "FAIL", receipt["status"])
            self.assertEqual([], receipt["cleanup_failures"])
            manifest = json.loads((receipt_path.parent / "sha256.json").read_text())
            self.assertIn("receipt.json", manifest)
            if fail_start:
                self.assertEqual("CalledProcessError", receipt["error_class"])
                self.assertEqual("synthetic start diagnostic\n", (receipt_path.parent / "pg.log").read_text())
                self.assertIn("pg-runtime.json", manifest)
                self.assertIn("pg.log", manifest)
        creates = [c for c in calls if c[1] == "create"]
        self.assertTrue(all("--pull=never" in c and "--cap-drop=ALL" in c for c in creates))
        # Inspect Docker options only; ttyd itself legitimately uses -p 7681.
        options = [c[:c.index(digest)] for c in creates if digest in c]
        self.assertFalse(any("-p" in c or "--privileged" in c or "/var/run/docker.sock" in " ".join(c) for c in options))
        network = next(c for c in calls if c[1:3] == ["network", "create"])
        self.assertIn("--internal", network)
        if fail_create:
            # A failed create may be a name collision: never adopt/remove that name.
            self.assertFalse(any(c[1] in {"start", "logs", "rm"} for c in calls))
            self.assertEqual(1, len(creates))
            self.assertTrue(any(c[1:3] == ["volume", "rm"] for c in calls))
            self.assertTrue(any(c[1:3] == ["network", "rm"] for c in calls))
            return
        last_log = max(i for i, c in enumerate(calls) if c[1] == "logs")
        first_remove = min(i for i, c in enumerate(calls) if c[1] == "rm")
        self.assertLess(last_log, first_remove)
        if fail_start:
            name = "f0-access-" + "b" * 24 + "-pg"
            self.assertEqual(1, len(creates))
            self.assertEqual([["docker", "start", name]], [c for c in calls if c[1] == "start"])
            self.assertEqual([["docker", "rm", "-f", name]], [c for c in calls if c[1] == "rm"])
            self.assertLess(calls.index(["docker", "inspect", name]), first_remove)
            self.assertLess(first_remove, next(i for i, c in enumerate(calls) if c[1:3] == ["volume", "rm"]))
            self.assertLess(first_remove, next(i for i, c in enumerate(calls) if c[1:3] == ["network", "rm"]))
        else:
            self.assertTrue(any(c[1] == "cp" and c[2].endswith("report.json") for c in calls[:first_remove]))

    def test_findings_are_not_pass_and_evidence_precedes_cleanup(self):
        self.exercise_lifecycle()

    def test_boot_failure_retains_diagnostics_and_cleans_only_owned_resources(self):
        self.exercise_lifecycle(fail_boot=True)

    def test_start_failure_after_create_retains_and_removes_owned_container(self):
        self.exercise_lifecycle(fail_start=True)

    def test_create_failure_does_not_adopt_or_remove_unowned_container(self):
        self.exercise_lifecycle(fail_create=True)


if __name__ == "__main__":
    unittest.main()
