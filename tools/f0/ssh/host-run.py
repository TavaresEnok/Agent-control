#!/usr/bin/env python3
"""Manager-only physical gate after independent review. No daemon changes/pulls."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]


def main():
    if len(sys.argv) != 3 or not all(re.fullmatch(r"sha256:[a-f0-9]{64}", x) for x in sys.argv[1:]):
        raise SystemExit("Usage: python3 tools/f0/ssh/host-run.py CENTRAL_IMAGE_ID TARGET_IMAGE_ID")
    token = secrets.token_hex(16)
    name = "f0-ssh-" + token
    evidence = ROOT / "docs/validation/artifacts/ssh" / name
    evidence.mkdir(parents=True, mode=0o700)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C"}
    containers = []
    network = False
    commands = []
    cleanup_errors = []
    code = 1

    def write(filename, value):
        (evidence / filename).write_text(json.dumps(value, indent=2) + "\n")

    def call(*args, timeout=30):
        commands.append(list(args))
        result = subprocess.run(args, env=env, cwd=ROOT, capture_output=True, timeout=timeout)
        with (evidence / "operations.log").open("ab") as log:
            log.write(result.stdout + result.stderr)
        result.check_returncode()
        return result.stdout.decode().strip()

    try:
        for image in sys.argv[1:]:
            call("docker", "image", "inspect", image)
        for path in [ROOT / "app/services/coder/ssh_runner.rb", ROOT / "app/services/agent_control/open_ssh_transport.rb", *sorted((ROOT / "tools/f0/ssh").glob("*")), *sorted((ROOT / "test/f0/ssh").glob("*")), ROOT / "test/services/agent_control/open_ssh_transport_test.rb", ROOT / "test/services/coder/ssh_runner_test.rb", ROOT / "docs/validation/F0-SSH-INTEGRADO.md"]:
            if path.is_file():
                target = evidence / "code" / path.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())
        call("docker", "network", "create", "--internal", "--label", "agent-control.fixture=" + token, name)
        network = True
        for role, image in zip(("central", "target"), sys.argv[1:]):
            container = name + "-" + role
            args = ["docker", "create", "--name", container, "--label", "agent-control.fixture=" + token,
                    "--network", name, "--network-alias", role, "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
                    "--tmpfs", "/lab:rw,mode=0755", "--security-opt", "no-new-privileges:true"]
            if role == "central":
                args += ["--mount", f"type=bind,source={ROOT},target=/work,readonly",
                         "--mount", f"type=bind,source={evidence},target=/evidence", "--workdir", "/work",
                         "-e", "BUNDLE_GEMFILE=/work/tools/f0/integrated/Gemfile", "-e", "BUNDLE_FROZEN=true"]
            args += [image]
            if role == "central":
                args += ["sleep", "infinity"]
            call(*args)
            containers.append(container)
            call("docker", "start", container)
        central, target = containers
        # Administrative channel creates/copies public host key BEFORE any SSH.
        # Never uses the connection being tested to establish its authority.
        for _ in range(30):
            try:
                call("docker", "exec", target, "test", "-f", "/lab/host_key.pub")
                break
            except subprocess.CalledProcessError:
                time.sleep(0.2)
        else:
            raise RuntimeError("target fixture did not initialize")
        call("docker", "exec", central, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", "/lab/client_key")
        call("docker", "exec", central, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", "/lab/wrong_host")
        with tempfile.TemporaryDirectory(prefix=name) as temp:
            temp = Path(temp)
            for container, source, filename in [(target, "/lab/host_key.pub", "host.pub"),
                                                 (central, "/lab/client_key.pub", "client.pub"),
                                                 (central, "/lab/wrong_host.pub", "wrong.pub")]:
                call("docker", "cp", container + ":" + source, str(temp / filename))
            call("docker", "cp", str(temp / "client.pub"), target + ":/lab/authorized_keys")
            call("docker", "exec", target, "chmod", "644", "/lab/authorized_keys")
            for filename, config_name, known_name in [("host.pub", "config.json", "known_hosts"), ("wrong.pub", "wrong-config.json", "wrong_hosts")]:
                fields = (temp / filename).read_text().split()
                fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(base64.b64decode(fields[1])).digest()).decode().rstrip("=")
                known = "f0-lab-pinned " + " ".join(fields[:2]) + "\n"
                (temp / known_name).write_text(known)
                config = dict(host="target", user="lab", identity_file="/lab/client_key", known_hosts_file="/lab/" + known_name, fingerprint=fingerprint, lab_opt_in=True)
                (temp / config_name).write_text(json.dumps(config))
                call("docker", "cp", str(temp / known_name), central + ":/lab/" + known_name)
                call("docker", "cp", str(temp / config_name), central + ":/lab/" + config_name)
                write(config_name, config)
                (evidence / known_name).write_text(known)
            (evidence / "host-key.pub").write_bytes((temp / "host.pub").read_bytes())
        if call("docker", "exec", central, "ruby", "-e", "print RUBY_VERSION") != "4.0.9":
            raise RuntimeError("Ruby 4.0.9 required")
        for script in ["test/services/agent_control/open_ssh_transport_test.rb", "test/f0/ssh/runner_test.rb", "tools/f0/ssh/scenario.rb"]:
            output = call("docker", "exec", central, "timeout", "--kill-after=10s", "180s", "ruby", script, timeout=200)
            (evidence / (Path(script).stem + ".log")).write_text(output + "\n")
        code = 0
    finally:
        # Capture logs/inspect/job journal before removing exclusive resources.
        write("gate.json", dict(exit_code=code, token=token, physical="PASS" if code == 0 else "FAIL", forced_channel_drop="NOT RUN"))
        for container in reversed(containers):
            for command in [("docker", "logs", container), ("docker", "inspect", container)]:
                try:
                    call(*command)
                except Exception as exc:
                    cleanup_errors.append(str(exc))
            if container.endswith("-target"):
                try:
                    call("docker", "cp", container + ":/tmp/aixle-jobs", str(evidence / "journal"))
                except Exception as exc:
                    cleanup_errors.append(str(exc))
            try:
                call("docker", "rm", "-f", container)
            except Exception as exc:
                cleanup_errors.append(str(exc))
        if network:
            try:
                call("docker", "network", "rm", name)
            except Exception as exc:
                cleanup_errors.append(str(exc))
        write("cleanup.json", dict(errors=cleanup_errors, passed=not cleanup_errors))
        write("commands.json", commands)
        write("hashes.json", {str(p.relative_to(evidence)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(evidence.rglob("*")) if p.is_file() and p.name != "hashes.json"})
    return code or bool(cleanup_errors)


if __name__ == "__main__":
    sys.exit(main())
