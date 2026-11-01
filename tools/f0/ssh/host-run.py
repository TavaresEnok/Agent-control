#!/usr/bin/env python3
"""Manager-only physical gate after independent review. No daemon changes/pulls."""
import base64
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import subprocess
import sys
import tempfile
import tarfile
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lab_network import Ownership, preflight, runtime

ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C"}
PUBLIC_PATHS = {"/lab/host_key.pub", "/lab/client_key.pub", "/lab/wrong_host.pub"}
WRITE_PATHS = {"/lab/authorized_keys", "/lab/known_hosts", "/lab/wrong_hosts",
               "/lab/config.json", "/lab/wrong-config.json"}
PUBLIC_LIMIT = 1024
FILE_LIMIT = 4096
JOURNAL_LIMIT = 8 * 1024 * 1024


def binary_run(argv, payload=None, limit=FILE_LIMIT):
    """Bound both output streams; stdin is binary and never part of argv/logs."""
    with tempfile.TemporaryFile() as source:
        if payload is not None:
            source.write(payload)
        source.seek(0)
        with subprocess.Popen(argv, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=ENV, cwd=ROOT) as process:
            output = {process.stdout: bytearray(), process.stderr: bytearray()}
            deadline = time.monotonic() + 30
            try:
                with selectors.DefaultSelector() as selector:
                    for stream in output:
                        selector.register(stream, selectors.EVENT_READ)
                    while selector.get_map():
                        if time.monotonic() >= deadline:
                            raise TimeoutError("administrative IO timeout")
                        for key, _ in selector.select(0.1):
                            chunk = os.read(key.fileobj.fileno(), 65536)
                            if not chunk:
                                selector.unregister(key.fileobj)
                                continue
                            output[key.fileobj].extend(chunk)
                            if sum(map(len, output.values())) > limit:
                                raise ValueError("administrative IO output limit")
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
                if process.returncode:
                    # Do not include untrusted output or payload in errors.
                    raise RuntimeError("administrative IO failed (exit %s)" % process.returncode)
                return bytes(output[process.stdout])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


class FixtureIO:
    def __init__(self, commands):
        self.commands = commands

    def execute(self, container, *args, payload=None, limit=FILE_LIMIT):
        argv = ["docker", "exec", "-i", container, "/usr/bin/env", "-i",
                "PATH=/usr/bin:/bin", "HOME=/nonexistent", "LANG=C", *args]
        self.commands.append(argv)
        return binary_run(argv, payload, limit)

    def public(self, container, path):
        if path not in PUBLIC_PATHS:
            raise ValueError("public key path refused")
        value = self.execute(container, "/bin/cat", path, limit=PUBLIC_LIMIT)
        validate_public(value)
        return value

    def write(self, container, path, value):
        if path not in WRITE_PATHS or not isinstance(value, bytes) or not 0 < len(value) <= FILE_LIMIT:
            raise ValueError("fixture write path/size refused")
        if path == "/lab/authorized_keys":
            validate_public(value)
        elif path in ("/lab/known_hosts", "/lab/wrong_hosts"):
            prefix = b"f0-lab-pinned "
            if not value.startswith(prefix):
                raise ValueError("known hosts alias refused")
            validate_public(value[len(prefix):])
        else:
            config = json.loads(value)
            known = "/lab/known_hosts" if path == "/lab/config.json" else "/lab/wrong_hosts"
            expected = dict(host="target", user="lab", identity_file="/lab/client_key",
                            known_hosts_file=known, lab_opt_in=True)
            if (not isinstance(config, dict) or set(config) != set(expected) | {"fingerprint"}
                    or any(config.get(k) != v for k, v in expected.items())
                    or not isinstance(config.get("fingerprint"), str)
                    or not re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", config["fingerprint"])):
                raise ValueError("fixture pin config refused")
        if self.execute(container, "/usr/bin/tee", path, payload=value) != value:
            raise ValueError("partial administrative write")
        self.execute(container, "/bin/chmod", "644", path)
        if self.execute(container, "/bin/cat", path) != value:
            raise ValueError("administrative readback mismatch")
        if self.execute(container, "/usr/bin/stat", "-c", "%a", path).strip() != b"644":
            raise ValueError("fixture permissions mismatch")

    def journal(self, container, evidence, required):
        # Before scenario entry no job can exist; absence is a phase result.
        if not required:
            return {"status": "NOTRUN", "reason": "absent-before-scenario"}
        raw = self.execute(container, "/bin/tar", "-C", "/tmp", "-cf", "-", "aixle-jobs",
                           limit=JOURNAL_LIMIT)
        validate_journal(raw)
        (evidence / "journal.tar").write_bytes(raw)
        return {"status": "PASS", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def validate_public(value):
    if not isinstance(value, bytes) or not 0 < len(value) <= PUBLIC_LIMIT:
        raise ValueError("public key size refused")
    if not re.fullmatch(rb"ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n\x00]*)?\n?", value):
        raise ValueError("public key format refused")
    blob = base64.b64decode(value.split()[1], validate=True)
    if len(blob) != 51 or blob[:19] != b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20":
        raise ValueError("ed25519 key blob refused")


def validate_journal(raw):
    if not raw or len(raw) > JOURNAL_LIMIT or len(raw) % tarfile.BLOCKSIZE:
        raise ValueError("journal size refused")
    files, total = 0, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for member in archive:
            parts = member.name.rstrip("/").split("/")
            if (not parts or parts[0] != "aixle-jobs" or any(p in ("", ".", "..") for p in parts)
                    or not (member.isfile() or member.isdir())
                    or any("key" in p.lower() for p in parts)):
                raise ValueError("journal member refused")
            total += member.size
            if total > JOURNAL_LIMIT or member.size < 0:
                raise ValueError("journal expanded size refused")
            files += member.isfile()
        # tarfile stops at the first end marker and ignores any following bytes.
        # Its offset is the padded end of the last parsed member. Require the
        # complete remaining stream to be the two EOF blocks plus zero padding,
        # so concatenated archives or unvalidated suffixes are never retained.
        trailer = raw[archive.offset:]
        if len(trailer) < 2 * tarfile.BLOCKSIZE or any(trailer):
            raise ValueError("journal termination/padding refused")
    if not files:
        raise ValueError("required journal is empty")


def main(argv=None):
    parser = argparse.ArgumentParser(usage="Usage: %(prog)s CENTRAL_IMAGE_ID TARGET_IMAGE_ID --subnet CIDR [--seccomp-compat]")
    parser.add_argument("central")
    parser.add_argument("target")
    parser.add_argument("--subnet", required=True)
    parser.add_argument("--seccomp-compat", action="store_true")
    options = parser.parse_args(argv)
    images = (options.central, options.target)
    if not all(re.fullmatch(r"sha256:[a-f0-9]{64}", x) for x in images):
        parser.error("immutable local image IDs required")
    def read(*args):
        return subprocess.run(args, env=ENV, cwd=ROOT, capture_output=True, check=True, timeout=30).stdout.decode()
    subnet = preflight(options.subnet, read)
    token = secrets.token_hex(16)
    name = "f0-ssh-" + token
    evidence = ROOT / "docs/validation/artifacts/ssh" / name
    evidence.mkdir(parents=True, mode=0o700)
    env = ENV
    containers = []
    commands = []
    cleanup_errors = []
    capture_errors = []
    scenario_started = False
    fixture_io = FixtureIO(commands)
    code = 1

    def write(filename, value):
        (evidence / filename).write_text(json.dumps(value, indent=2) + "\n")

    def retain(filename, value):
        # Evidence storage errors must not prevent ownership-checked removal.
        try:
            write(filename, value)
        except Exception as exc:
            capture_errors.append(type(exc).__name__)

    def call(*args, timeout=30):
        commands.append(list(args))
        result = subprocess.run(args, env=env, cwd=ROOT, capture_output=True, timeout=timeout)
        # Inspect is parsed in memory only: Config.Env must never enter evidence.
        if "inspect" not in args:
            with (evidence / "operations.log").open("ab") as log:
                log.write(result.stdout + result.stderr)
        result.check_returncode()
        return result.stdout.decode().strip()

    ownership = Ownership(call, token)
    try:
        for image in images:
            call("docker", "image", "inspect", image)
        for path in [ROOT / "app/services/coder/ssh_runner.rb", ROOT / "app/services/agent_control/open_ssh_transport.rb", ROOT / "tools/f0/lab_network.py", *sorted((ROOT / "tools/f0/ssh").glob("*")), *sorted((ROOT / "tools/f0/ssh/tests").glob("*.rb")), *sorted((ROOT / "test/f0/ssh").glob("*")), ROOT / "test/services/agent_control/open_ssh_transport_test.rb", ROOT / "test/services/coder/ssh_runner_test.rb", ROOT / "docs/validation/F0-SSH-INTEGRADO.md", ROOT / "docs/validation/F0-SSH-TMPFS-IO.md"]:
            if path.is_file():
                target = evidence / "code" / path.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())
        ownership.create("network", name, "network", "create", "--internal", "--subnet", subnet,
                         "--label", "agent-control.fixture=" + token, name)
        ownership.require("network", name)
        for role, image in zip(("central", "target"), images):
            container = name + "-" + role
            args = ["create", "--pull=never", "--name", container, "--label", "agent-control.fixture=" + token,
                    "--network", name, "--network-alias", role, "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
                    "--tmpfs", "/lab:rw,mode=0755", "--security-opt", "no-new-privileges:true"]
            if options.seccomp_compat:
                args += ["--security-opt", "seccomp=unconfined"]
            if role == "central":
                args += ["--mount", f"type=bind,source={ROOT},target=/work,readonly",
                         "--mount", f"type=bind,source={evidence},target=/evidence", "--workdir", "/work",
                         "-e", "BUNDLE_GEMFILE=/work/tools/f0/integrated/Gemfile", "-e", "BUNDLE_FROZEN=true"]
            args += [image]
            if role == "central":
                args += ["sleep", "infinity"]
            ownership.create("container", container, *args)
            ownership.require("container", container)
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
        host_key = fixture_io.public(target, "/lab/host_key.pub")
        client_key = fixture_io.public(central, "/lab/client_key.pub")
        wrong_key = fixture_io.public(central, "/lab/wrong_host.pub")
        fixture_io.write(target, "/lab/authorized_keys", client_key)
        for public, config_name, known_name in [(host_key, "config.json", "known_hosts"), (wrong_key, "wrong-config.json", "wrong_hosts")]:
            fields = public.decode("ascii").split()
            fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(base64.b64decode(fields[1])).digest()).decode().rstrip("=")
            known = ("f0-lab-pinned " + " ".join(fields[:2]) + "\n").encode("ascii")
            config = dict(host="target", user="lab", identity_file="/lab/client_key", known_hosts_file="/lab/" + known_name, fingerprint=fingerprint, lab_opt_in=True)
            fixture_io.write(central, "/lab/" + known_name, known)
            fixture_io.write(central, "/lab/" + config_name, json.dumps(config).encode("ascii"))
            write(config_name, config)
            (evidence / known_name).write_bytes(known)
        (evidence / "host-key.pub").write_bytes(host_key)
        if call("docker", "exec", central, "ruby", "-e", "print RUBY_VERSION") != "4.0.9":
            raise RuntimeError("Ruby 4.0.9 required")
        for script in ["test/services/agent_control/open_ssh_transport_test.rb", "tools/f0/ssh/tests/runner_test.rb", "tools/f0/ssh/scenario.rb"]:
            if script == "tools/f0/ssh/scenario.rb":
                scenario_started = True
            output = call("docker", "exec", central, "timeout", "--kill-after=10s", "180s", "ruby", script, timeout=200)
            (evidence / (Path(script).stem + ".log")).write_text(output + "\n")
        code = 0
    finally:
        containers = [resource for kind, resource in ownership.resources if kind == "container"]
        # Capture logs/inspect/job journal before removing exclusive resources.
        retain("gate.json", dict(exit_code=code, token=token, physical="PENDING" if code == 0 else "FAIL", forced_channel_drop="NOT RUN",
                                subnet=subnet, seccomp="unconfined" if options.seccomp_compat else "docker-default",
                                resources=ownership.receipt()))
        for container in reversed(containers):
            for command in [("docker", "logs", container)]:
                try:
                    call(*command)
                except Exception as exc:
                    capture_errors.append(type(exc).__name__)
            try:
                data = json.loads(call("docker", "container", "inspect", container))[0]
                retain(container + "-runtime.json", runtime(data))
            except Exception as exc:
                capture_errors.append(type(exc).__name__)
            if container.endswith("-target"):
                try:
                    retain("journal.json", fixture_io.journal(container, evidence, scenario_started))
                except Exception as exc:
                    capture_errors.append(type(exc).__name__)
                    retain("journal.json", dict(status="FAIL", error=type(exc).__name__))
        if not (evidence / "journal.json").exists():
            retain("journal.json", dict(status="NOTRUN", reason="absent-before-target"))
        # Retain every container's effective profile before the first removal.
        for container in reversed(containers):
            try:
                ownership.remove("container", container)
            except Exception as exc:
                cleanup_errors.append(str(exc))
        if ("network", name) in ownership.resources:
            try:
                ownership.remove("network", name)
            except Exception as exc:
                cleanup_errors.append(str(exc))
        write("cleanup.json", dict(errors=cleanup_errors, passed=not cleanup_errors))
        write("capture.json", dict(errors=capture_errors, passed=not capture_errors))
        write("gate.json", dict(exit_code=code or int(bool(capture_errors or cleanup_errors)), token=token,
                                physical="PASS" if code == 0 and not capture_errors and not cleanup_errors else "FAIL",
                                scenario="started" if scenario_started else "NOTRUN", forced_channel_drop="NOT RUN",
                                subnet=subnet, seccomp="unconfined" if options.seccomp_compat else "docker-default",
                                resources=ownership.receipt()))
        write("commands.json", commands)
        write("hashes.json", {str(p.relative_to(evidence)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(evidence.rglob("*")) if p.is_file() and p.name != "hashes.json"})
    return code or bool(cleanup_errors or capture_errors)


if __name__ == "__main__":
    sys.exit(main())
