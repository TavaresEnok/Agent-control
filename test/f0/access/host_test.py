"""Offline checks of the administrative lifecycle, not Rails authorization tests."""
import importlib.util
import base64
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
        self.assertIn("tools/f0/access/tests/mcp_evidence_test.rb", names)
        self.assertIn("tools/f0/access/session_cookie.rb", names)
        self.assertIn("tools/f0/access/tests/session_cookie_test.rb", names)
        self.assertFalse(any(Path(n).name.startswith(".env") or n.endswith((".key", ".enc", ".pem")) for n in names))
        self.assertNotIn("test/test_helper.rb", names)
        self.assertFalse(any("artifacts/" in n for n in names))

    def test_mutable_image_rejected_before_docker(self):
        with patch.object(host, "command") as execute:
            with self.assertRaises(ValueError):
                host.immutable("postgres:latest")
            execute.assert_not_called()

    def exercise_lifecycle(self, fail_boot=False, fail_start=False, fail_create=False, partial_create=False, compat=True,
                           partial_network=False, pg_error=None, collector_error=False, missing=False, web_exit=1,
                           collector_partial=False, report_pass=False, removal_error=False, pg_transient=False):
        calls = []
        retained_before_removal = []
        digest = "sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as temporary:
            resources = {}
            def fake_command(argv, **kwargs):
                calls.append(argv)
                words = argv[1:]
                output = b""
                if argv[0] == "ip":
                    return subprocess.CompletedProcess(argv, 0, stdout=b'[]')
                if words[:3] == ["network", "ls", "--quiet"]:
                    return subprocess.CompletedProcess(argv, 0, stdout=b'')
                if words[0] == "rm" or words[:2] in (["volume", "rm"], ["network", "rm"]):
                    # Observe disk at the actual removal boundary, not only after run.
                    receipt_path = next(Path(temporary).rglob("receipt.json"))
                    retained = json.loads(receipt_path.read_text())
                    self.assertEqual("PENDING", retained["cleanup_status"])
                    self.assertEqual("172.28.96.0/28", retained["subnet"])
                    self.assertEqual("unconfined" if compat else "docker-default", retained["seccomp"])
                    self.assertEqual(set(resources), {r["id"] for r in retained["resources"]})
                    for resource in retained["resources"]:
                        self.assertEqual(resource["name"], resources[resource["id"]]["Name"])
                        if resource["kind"] == "container":
                            runtime_path = receipt_path.parent / (resource["name"].rsplit("-", 1)[1] + "-runtime.json")
                            effective = json.loads(runtime_path.read_text())["limits"]
                            self.assertEqual(["no-new-privileges"] + (["seccomp=unconfined"] if compat else []),
                                             effective["SecurityOpt"])
                            self.assertEqual(["ALL"], effective["CapDrop"])
                    self.assertNotIn("SIGNING_KEY", receipt_path.read_text())
                    retained_before_removal.append(retained)
                if words[0] in {"network", "volume", "container"} and words[1] == "inspect":
                    if words[2] not in resources:
                        raise subprocess.CalledProcessError(1, argv)
                    return subprocess.CompletedProcess(argv, 0, stdout=json.dumps([resources[words[2]]]).encode())
                if (words[0] == "start" and fail_start) or (words[0] == "create" and fail_create):
                    raise subprocess.CalledProcessError(125, argv)
                if words[0] == "logs":
                    output = b"synthetic start diagnostic\n"
                if words[0] == "exec" and "pg_isready" in words and pg_transient:
                    if sum("pg_isready" in c for c in calls) == 1:
                        raise subprocess.CalledProcessError(2, argv, stderr=b'Connection refused SIGNING_KEY=secret')
                if words[0] == "exec" and "psql" in words:
                    if words[-1].startswith("SELECT current_user"):
                        output = b"f0_access_lab|postgres|127.0.0.1|5432\n"
                    elif pg_error and words[-1].startswith(pg_error):
                        raise subprocess.CalledProcessError(3, argv, stderr=b'ERROR: permission denied SIGNING_KEY=secret')
                if words[:2] == ["start", "--attach"]:
                    if collector_error:
                        raise subprocess.CalledProcessError(125, argv)
                    output = json.dumps({name: ({"error": "missing"} if missing else {
                        "data": base64.b64encode(data).decode()}) for name, data in (
                            ("report.json", json.dumps({"status": "PASS" if report_pass else "FAIL_OR_NOTRUN",
                                "rows": [{"name": "readiness/gateway", "status": "NOTRUN", "phase": "gateway",
                                          "endpoint": "gateway/terminal/tty", "attempts": 4,
                                          "reason": "startup_deadline", "last_error_class": "Net::OpenTimeout"}]}).encode()),
                            ("gateway.yml", b'http: {}\n'))}).encode()
                if words[:2] == ["exec", "f0-access-" + "b" * 24 + "-web"] and "test" in words and fail_boot:
                    raise subprocess.CalledProcessError(1, argv)
                if words[:2] == ["inspect", "--format"]:
                    output = b"0" if "{{.State.ExitCode}}" in words else (b"false" if fail_boot else b"true")
                elif words[0] == "inspect":
                    output = json.dumps([resources[words[1]]]).encode()
                elif words[0] == "wait":
                    output = str(web_exit).encode()  # Negative security findings must propagate.
                elif words[0] == "cp":
                    Path(words[-1]).write_text('{"status":"FAIL_OR_NOTRUN"}')
                if words[0] == "create" or words[:2] in (["network", "create"], ["volume", "create"]):
                    name = words[words.index("--name") + 1] if words[0] == "create" else words[-1]
                    resources[name] = {"Id": name, "Name": name, "Labels": {"agent-control.fixture": "b" * 24},
                                       "Config": {"Labels": {"agent-control.fixture": "b" * 24}, "Env": ["SIGNING_KEY=secret"]},
                                       "NetworkSettings": {}, "State": {}, "HostConfig": {
                                           "Memory": 1, "NanoCpus": 1, "PidsLimit": 1, "PortBindings": {},
                                           "SecurityOpt": ["no-new-privileges"] + (["seccomp=unconfined"] if compat else []),
                                           "CapDrop": ["ALL"]}}
                    if (partial_create and words[0] == "create") or (partial_network and words[:2] == ["network", "create"]) or (collector_partial and name.endswith("-collector")):
                        raise subprocess.CalledProcessError(125, argv)
                if removal_error and words[0] == "rm" and words[-1].endswith("-collector"):
                    raise subprocess.CalledProcessError(1, argv)
                return subprocess.CompletedProcess(argv, 0, stdout=output, stderr=b"")

            with patch.object(host, "ROOT", Path(temporary)), patch.object(host, "command", side_effect=fake_command), patch.object(host.secrets, "token_hex", return_value="b" * 24):
                self.assertEqual(0 if report_pass and not removal_error else 1,
                                 host.run(digest, digest, "172.28.96.0/28", seccomp_compat=compat))
            receipt_path = next(Path(temporary).rglob("receipt.json"))
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual("NOTRUN" if fail_boot or fail_start or fail_create or partial_create or partial_network or pg_error else ("PASS" if web_exit == 0 and (report_pass or missing or collector_error or collector_partial) else "FAIL"), receipt["status"])
            self.assertEqual(["f0-access-" + "b" * 24 + "-collector"] if removal_error else [], receipt["cleanup_failures"])
            self.assertEqual("FAIL" if removal_error else "PASS", receipt["cleanup_status"])
            if removal_error:
                self.assertFalse(receipt.get("retention_error", False))
                self.assertEqual("FAIL", receipt["gate_status"])
            if report_pass and not removal_error:
                self.assertEqual("PASS", receipt["gate_status"])
            self.assertTrue(retained_before_removal)
            self.assertEqual("unconfined" if compat else "docker-default", receipt["seccomp"])
            self.assertEqual("172.28.96.0/28", receipt["subnet"])
            self.assertNotIn("SIGNING_KEY", "".join(p.read_text() for p in receipt_path.parent.glob("*.json")))
            manifest = json.loads((receipt_path.parent / "sha256.json").read_text())
            self.assertIn("receipt.json", manifest)
            if pg_error:
                self.assertEqual("pg-create" if pg_error == "CREATE" else "pg-comment", receipt["stage"])
                self.assertEqual(3, receipt["diagnostic"]["exit_code"])
                self.assertEqual(["permission-denied"], receipt["diagnostic"]["stderr_categories"])
                self.assertFalse(any("-web" in c[-1] for c in calls if c[1] == "start"))
            if pg_transient:
                self.assertNotIn("diagnostic", receipt)
                self.assertEqual("web-completed", receipt["stage"])
                self.assertEqual("recovered", receipt["administrative_attempt_errors"][0]["outcome"])
                self.assertEqual("pg-readiness", receipt["administrative_attempt_errors"][0]["stage"])
                self.assertEqual("Net::OpenTimeout", receipt["startup"][0]["last_error_class"])
                self.assertEqual(4, receipt["startup"][0]["attempts"])
            if collector_error or collector_partial or missing:
                self.assertTrue(receipt["retention_error"])
                self.assertEqual("FAIL", receipt["gate_status"])
                self.assertNotIn("report.json", manifest)
            if not (fail_boot or fail_start or fail_create or partial_create or partial_network or pg_error):
                collector = next(c for c in calls if c[1] == "create" and "-collector" in " ".join(c))
                self.assertEqual("none", collector[collector.index("--network") + 1])
                self.assertIn("--read-only", collector)
                self.assertIn("readonly", collector[collector.index("--mount") + 1])
                self.assertEqual("ruby", collector[collector.index("--entrypoint") + 1])
                self.assertIn("--memory", collector)
                self.assertTrue(any(r["name"].endswith("-collector") for r in receipt["resources"]))
                self.assertLess(next(i for i, c in enumerate(calls) if c[1:3] == ["wait", "f0-access-" + "b" * 24 + "-web"]),
                                calls.index(collector))
            if fail_start or partial_create:
                self.assertEqual("CalledProcessError", receipt["error_class"])
                self.assertEqual("synthetic start diagnostic\n", (receipt_path.parent / "pg.log").read_text())
                self.assertIn("pg-runtime.json", manifest)
                self.assertIn("pg.log", manifest)
        creates = [c for c in calls if c[1] == "create"]
        self.assertTrue(all("--pull=never" in c and "--cap-drop=ALL" in c for c in creates))
        self.assertTrue(all(("seccomp=unconfined" in c) == compat and "no-new-privileges" in c and "--pids-limit" in c for c in creates))
        # Inspect Docker options only; ttyd itself legitimately uses -p 7681.
        options = [c[:c.index(digest)] for c in creates if digest in c]
        self.assertFalse(any("-p" in c or "--privileged" in c or "/var/run/docker.sock" in " ".join(c) for c in options))
        network = next(c for c in calls if c[1:3] == ["network", "create"])
        self.assertIn("--internal", network)
        self.assertEqual("172.28.96.0/28", network[network.index("--subnet") + 1])
        if partial_network:
            self.assertEqual("CalledProcessError", receipt["error_class"])
            self.assertEqual(["network"], [r["kind"] for r in retained_before_removal[0]["resources"]])
            self.assertFalse(creates)
            self.assertEqual([["docker", "network", "rm", "f0-access-" + "b" * 24]],
                             [c for c in calls if c[1:3] == ["network", "rm"]])
            return
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
        if fail_start or partial_create:
            name = "f0-access-" + "b" * 24 + "-pg"
            self.assertEqual(1, len(creates))
            self.assertEqual([] if partial_create else [["docker", "start", name]], [c for c in calls if c[1] == "start"])
            self.assertEqual([["docker", "rm", "-f", name]], [c for c in calls if c[1] == "rm"])
            self.assertLess(calls.index(["docker", "inspect", name]), first_remove)
            self.assertLess(first_remove, next(i for i, c in enumerate(calls) if c[1:3] == ["volume", "rm"]))
            self.assertLess(first_remove, next(i for i, c in enumerate(calls) if c[1:3] == ["network", "rm"]))
        self.assertFalse(any(c[1] == "cp" for c in calls))
        if not (fail_start or partial_create or pg_error or collector_partial):
            self.assertTrue(any(c[1:3] == ["start", "--attach"] for c in calls[:first_remove]))

    def test_create_and_comment_diagnostics_never_export_argv_or_stderr_secrets(self):
        for phase in ("CREATE", "COMMENT"):
            with self.subTest(phase=phase):
                self.exercise_lifecycle(pg_error=phase)

    def test_recovered_pg_attempt_is_history_and_web_startup_is_retained(self):
        with patch.object(host.time, "sleep"):
            self.exercise_lifecycle(pg_transient=True)

    def test_stopped_web_artifacts_missing_never_pass(self):
        self.exercise_lifecycle(missing=True, web_exit=0)

    def test_collector_start_failure_retains_owned_helper_and_cleans_it(self):
        self.exercise_lifecycle(collector_error=True, web_exit=0)

    def test_partially_created_collector_is_retained_and_removed_by_ownership(self):
        self.exercise_lifecycle(collector_partial=True, web_exit=0)

    def test_zero_exit_with_negative_report_cannot_pass(self):
        self.exercise_lifecycle(web_exit=0)

    def test_successful_artifact_retention_does_not_hide_cleanup_failure(self):
        self.exercise_lifecycle(web_exit=0, report_pass=True, removal_error=True)

    def test_positive_administrative_gate_requires_report_retention_and_cleanup(self):
        self.exercise_lifecycle(web_exit=0, report_pass=True)

    def test_readiness_rejects_temporary_socket_server_then_checks_final_identity(self):
        calls = []
        def execute(stage, *args, **kwargs):
            calls.append((stage, args))
            if stage == "pg-readiness":
                self.assertIn("127.0.0.1", args)
                if len(calls) == 1:
                    raise subprocess.CalledProcessError(2, args)
            if stage == "pg-identity":
                return "f0_access_lab|postgres|127.0.0.1|5432\n"
            return ""
        with patch.object(host.time, "sleep") as sleep:
            host.prepare_pg(execute, "owned-pg", "fixture")
        self.assertEqual(1, sleep.call_count)
        self.assertEqual(["pg-readiness", "pg-readiness", "pg-identity", "pg-create", "pg-comment"],
                         [stage for stage, _ in calls])

    def test_wrong_identity_and_readiness_timeout_prevent_ddl(self):
        calls = []
        def execute(stage, *args, **kwargs):
            calls.append(stage)
            return "wrong-role|postgres|127.0.0.1|5432"
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            host.prepare_pg(execute, "owned-pg", "fixture")
        self.assertNotIn("pg-create", calls)
        with patch.object(host.time, "monotonic", side_effect=[0, 41]), \
                patch.object(host.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "readiness timeout"):
                host.prepare_pg(lambda *a, **k: (_ for _ in ()).throw(subprocess.CalledProcessError(2, [])), "owned-pg", "fixture")
            sleep.assert_not_called()

    def test_artifact_types_size_and_untrusted_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            with self.assertRaises(ValueError):
                host.retain_artifacts('{"../../secret": {}}', out)
            for data in (b'[]', b'{"status":"unexpected"}', b'x' * (host.ARTIFACT_LIMIT + 1)):
                errors = host.retain_artifacts(json.dumps({"report.json": {"data": base64.b64encode(data).decode()},
                                                          "gateway.yml": {"error": "missing"}}), out)
                self.assertEqual({"report.json", "gateway.yml"}, set(errors))
                self.assertEqual([], list(out.iterdir()))

    def test_findings_are_not_pass_and_evidence_precedes_cleanup(self):
        self.exercise_lifecycle()

    def test_boot_failure_retains_diagnostics_and_cleans_only_owned_resources(self):
        self.exercise_lifecycle(fail_boot=True)

    def test_start_failure_after_create_retains_and_removes_owned_container(self):
        self.exercise_lifecycle(fail_start=True)

    def test_create_failure_does_not_adopt_or_remove_unowned_container(self):
        self.exercise_lifecycle(fail_create=True)

    def test_partial_creation_retains_and_removes_confirmed_owned_container(self):
        self.exercise_lifecycle(partial_create=True)

    def test_partial_network_creation_persists_identity_before_cleanup(self):
        self.exercise_lifecycle(partial_network=True)

    def test_receipt_write_failure_prevents_resource_removal(self):
        write_text = Path.write_text

        def persist(path, *args, **kwargs):
            if path.name == "receipt.json":
                raise OSError("simulated receipt storage failure")
            return write_text(path, *args, **kwargs)

        with patch.object(Path, "write_text", autospec=True, side_effect=persist), \
                patch.object(host.Ownership, "remove") as remove:
            with self.assertRaisesRegex(OSError, "receipt storage failure"):
                self.exercise_lifecycle(fail_start=True)
            remove.assert_not_called()

    def test_default_profile_does_not_disable_seccomp(self):
        self.exercise_lifecycle(fail_start=True, compat=False)

    def test_invalid_subnet_never_calls_docker(self):
        with patch.object(host, "command") as execute:
            with self.assertRaises(ValueError):
                host.run("sha256:" + "a" * 64, "sha256:" + "a" * 64, "172.28.96.1/28")
            execute.assert_not_called()

    def test_route_overlap_never_mutates(self):
        calls = []
        def execute(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout=b'[{"dst":"172.28.0.0/16"}]' if argv[0] == "ip" else b'')
        with patch.object(host, "command", side_effect=execute):
            with self.assertRaises(ValueError):
                host.run("sha256:" + "a" * 64, "sha256:" + "a" * 64, "172.28.96.0/28")
        self.assertEqual(["docker", "network", "ls", "--quiet"], calls[0])
        self.assertEqual(2, len(calls))


if __name__ == "__main__":
    unittest.main()
