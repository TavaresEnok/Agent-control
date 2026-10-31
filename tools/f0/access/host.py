"""Manager-only Docker operation. No compose, Docker socket mount or host mutation.

build: filtered source context; online downloads with NO services.
run: local immutable image IDs only; exclusive internal network; no published ports.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lab_network import Ownership, preflight, runtime
BASE = "ruby@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df"
PG = "postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a"
ARTIFACT_LIMIT = 2 * 1024 * 1024
# Fixed paths only; no report-controlled paths, symlinks, devices or services.
COLLECT = r'''
require "json"
result = {}
%w[report.json gateway.yml].each do |name|
  begin
    path = "/lab-state/" + name
    stat = File.lstat(path)
    raise "invalid file" unless stat.file? && stat.size <= 2097152
    File.open(path, File::RDONLY | File::NOFOLLOW | File::NONBLOCK) do |f|
      raise "changed file" unless f.stat.ino == stat.ino && f.stat.dev == stat.dev
      bytes = f.read(2097153)
      raise "oversized file" if bytes.bytesize > 2097152
      result[name] = {"data" => [bytes].pack("m0")}
    end
  rescue Errno::ENOENT
    result[name] = {"error" => "missing"}
  rescue StandardError
    result[name] = {"error" => "invalid"}
  end
end
STDOUT.write(JSON.generate(result))
'''


def prepare_pg(execute, name, token):
    """TCP is unavailable in the entrypoint's temporary socket-only server."""
    connection = ("exec", name, "psql", "-X", "-w", "-h", "127.0.0.1", "-p", "5432",
                  "-U", "f0_access_lab", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c")
    deadline = time.monotonic() + 40
    while True:
        try:
            execute("pg-readiness", "exec", name, "pg_isready", "-h", "127.0.0.1", "-p", "5432",
                    "-U", "f0_access_lab", "-d", "postgres", timeout=3)
            identity = execute("pg-identity", *connection,
                               "SELECT current_user, current_database(), inet_server_addr(), inet_server_port()",
                               timeout=3).strip()
            if identity != "f0_access_lab|postgres|127.0.0.1|5432":
                raise RuntimeError("Disposable PG identity mismatch")
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if time.monotonic() >= deadline:
                raise RuntimeError("Disposable PG final TCP readiness timeout") from None
            time.sleep(1)
    # No IF NOT EXISTS: preexisting databases are refused before COMMENT/app DDL.
    execute("pg-create", *connection, "CREATE DATABASE aixle_test OWNER f0_access_lab")
    execute("pg-comment", *connection,
            f"COMMENT ON DATABASE aixle_test IS 'agent-control:access:disposable:{token}'")


def retain_artifacts(payload, out):
    if len(payload) > ARTIFACT_LIMIT * 3:
        raise ValueError("Oversized collector response")
    entries = json.loads(payload)
    if not isinstance(entries, dict) or set(entries) != {"report.json", "gateway.yml"}:
        raise ValueError("Invalid collector response")
    errors = {}
    for name in ("report.json", "gateway.yml"):
        try:
            entry = entries[name]
            if not isinstance(entry, dict) or set(entry) != {"data"} or not isinstance(entry["data"], str):
                raise ValueError("Missing or invalid artifact")
            data = base64.b64decode(entry["data"], validate=True)
            if not data or len(data) > ARTIFACT_LIMIT:
                raise ValueError("Invalid artifact size")
            text = data.decode("utf-8")
            if name == "report.json":
                report = json.loads(text)
                if not isinstance(report, dict) or report.get("status") not in {"PASS", "FAIL_OR_NOTRUN"}:
                    raise ValueError("Invalid report")
            elif "\x00" in text:
                raise ValueError("Invalid gateway text")
            (out / name).write_bytes(data)
        except (ValueError, TypeError, OSError):
            errors[name] = "missing-or-invalid"
    return errors


def source_paths():
    # Never send .env, credentials, .git, artifacts, existing auth, or node_modules.
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    names += [str(p.relative_to(ROOT)) for p in (ROOT / "tools/f0/access").glob("*") if p.is_file()]
    build_tests = {"test/f0/access/mcp_evidence_test.rb", "test/f0/access/session_cookie_test.rb",
                   "test/f0/access/readiness_test.rb"}
    names += sorted(build_tests)
    roots = {"app", "config", "lib", "db", "public", "bin"}
    for name in sorted(set(names)):
        p = Path(name)
        if not name or not (p.parts[0] in roots or name in {"Gemfile", "Gemfile.lock", ".ruby-version", "Rakefile", "config.ru", "docker/traefik/dynamic.yml"} or name in build_tests or name.startswith("tools/f0/access/")):
            continue
        if any(x.startswith(".env") or x in {"credentials", "node_modules", "artifacts", "__pycache__"} for x in p.parts):
            continue
        if p.suffix in {".key", ".pem", ".enc"} or "settings.local" in name or ".local." in name:
            continue
        path = ROOT / p
        if path.is_symlink() or not path.is_file():
            continue
        yield name, path


def command(args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop("timeout", 120), **kwargs)


def immutable(value):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}|[a-z0-9./_-]+@sha256:[a-f0-9]{64}", value):
        raise ValueError("Use an immutable local image ID/digest")
    command(["docker", "image", "inspect", value], stdout=subprocess.DEVNULL)
    return value


def build():
    # Build networking is explicitly separate from runtime. Does not pull services.
    with tempfile.TemporaryDirectory(prefix="f0-access-build-") as temp:
        context = Path(temp) / "context.tar"
        with tarfile.open(context, "w") as archive:
            for name, path in source_paths():
                archive.add(path, arcname=name, recursive=False)
        command(["docker", "build", "--network=host", "--build-arg", f"RUBY_BASE={BASE}",
                 "-f", "tools/f0/access/Dockerfile", "-t", "f0-access-candidate", "-"],
                stdin=context.open("rb"), timeout=3600)
        command(["docker", "image", "inspect", "--format", "{{.Id}}", "f0-access-candidate"])


def run(image, gateway, subnet, seccomp_compat=False):
    def call(*args):
        return command(list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode()

    subnet = preflight(subnet, call)
    image, gateway, pg = map(immutable, (image, gateway, PG))
    token = secrets.token_hex(12)
    prefix = "f0-access-" + token
    out = ROOT / "docs/validation/artifacts/access" / prefix
    out.mkdir(parents=True, mode=0o700)
    owned = []
    ownership = Ownership(call, token)
    result = {"status": "NOTRUN", "fixture": token, "images": [image, gateway, pg],
              "subnet": subnet, "seccomp": "unconfined" if seccomp_compat else "docker-default"}

    def docker(*args, timeout=120):
        return command(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout).stdout.decode()

    def administrative(stage, *args, **kwargs):
        result["stage"] = stage
        try:
            value = docker(*args, **kwargs)
            for attempt in result.get("administrative_attempt_errors", []):
                if attempt["stage"] == stage:
                    attempt["outcome"] = "recovered"
            if result.get("diagnostic", {}).get("stage") == stage:
                result.pop("diagnostic")
            return value
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            # Never persist argv or free-form stderr: either may contain keys.
            raw = error.stderr or b""
            if isinstance(raw, str):
                raw = raw.encode()
            result["diagnostic"] = {"stage": stage, "error_class": type(error).__name__,
                                    "exit_code": getattr(error, "returncode", None),
                                    "stderr_bytes": len(raw),
                                    "stderr_categories": [label for marker, label in (
                                        (b"already exists", "already-exists"),
                                        (b"Connection refused", "connection-refused"),
                                        (b"permission denied", "permission-denied"),
                                        (b"syntax error", "sql-syntax")) if marker in raw[:4096]]}
            result.setdefault("administrative_attempt_errors", []).append(
                dict(result["diagnostic"], outcome="attempt-failed"))
            raise

    def start(suffix, img, args=(), env=(), mounts=()):
        name = prefix + "-" + suffix
        # Ownership is confirmed separately by label and resource ID.
        argv = ["create", "--pull=never", "--name", name, "--label", f"agent-control.fixture={token}",
                "--network", prefix, "--network-alias", suffix, "--memory", "2g" if suffix == "web" else "512m",
                "--cpus", "2" if suffix == "web" else "1", "--pids-limit", "256", "--cap-drop=ALL",
                "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid"]
        if seccomp_compat:
            argv += ["--security-opt", "seccomp=unconfined"]
        for entry in env:
            argv += ["-e", entry]
        for mount in mounts:
            argv += ["--mount", mount]
        if suffix == "pg":
            argv += ["--user", "postgres"]
        ownership.create("container", name, *argv, img, *args)
        ownership.require("container", name)
        owned.append(name)
        # A failed start still leaves a container: retain and remove it in finally.
        # Failed create is retained only when its unique ownership label confirms it.
        administrative(suffix + "-start", "start", name)
        return name

    try:
        for kind, name in [("network", prefix), ("volume", prefix)] + [("container", prefix + "-" + s) for s in ("pg", "web", "gateway", "terminal", "collector")]:
            try:
                docker(kind, "inspect", name)
            except subprocess.CalledProcessError:
                pass
            else:
                raise RuntimeError("Preexisting resource refused")
        ownership.create("network", prefix, "network", "create", "--internal", "--subnet", subnet,
                         "--label", f"agent-control.fixture={token}", prefix)
        ownership.require("network", prefix)
        ownership.create("volume", prefix, "volume", "create", "--label", f"agent-control.fixture={token}", prefix)
        ownership.require("volume", prefix)
        state = f"type=volume,source={prefix},target=/lab-state"
        pg_name = start("pg", pg, env=("POSTGRES_USER=f0_access_lab", "POSTGRES_DB=postgres",
                        "POSTGRES_HOST_AUTH_METHOD=trust", "PGDATA=/tmp/pgdata"))
        prepare_pg(administrative, pg_name, token)
        term_cmd = (
            "ruby -rsocket -e 's=TCPServer.new(4040); loop { c=s.accept; c.gets; c.print \"HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nOK\"; c.close }' & "
            "ruby -rsocket -e 's=TCPServer.new(8443); loop { c=s.accept; c.gets; c.print \"HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nOK\"; c.close }' & "
            "ruby -rsocket -e 's=TCPServer.new(4041); loop { c=s.accept; c.gets; c.print \"HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nOK\"; c.close }' & "
            "ttyd -W -H X-Forwarded-User -p 7681 sh -c 'printf SYNTHETIC_TTYD_ACCESS; sleep 40'"
        )
        start("terminal", image, args=("sh", "-c", term_cmd))
        env = ("RAILS_ENV=test", "BUNDLE_FROZEN=true", "DB_HOST=pg", "DB_USERNAME=f0_access_lab",
               "DB_PASSWORD=", "F0_ACCESS_TOKEN=" + token, "RAILS_SECRET_KEY_BASE=" + secrets.token_hex(64),
               "DOMAIN=web:4000", "PROTOCOL=http", "SOLID_QUEUE_IN_PUMA=false", "MITM_DISABLED=true",
               "HOME=/tmp", "BOOTSNAP_CACHE_DIR=/tmp/bootsnap", "RAILS_LOG_TO_STDOUT=true")
        web = start("web", image, env=env, mounts=(state,))
        result["stage"] = "web-boot"
        # Gateway consumes config written by the real strategy's labels in run.rb.
        for _ in range(90):
            try:
                docker("exec", web, "test", "-f", "/lab-state/gateway.yml")
                break
            except subprocess.CalledProcessError:
                if docker("inspect", "--format", "{{.State.Running}}", web).strip() != "true":
                    raise RuntimeError("Rails boot/fixture preparation failed; see web.log")
                time.sleep(1)
        else:
            raise RuntimeError("Rails config readiness timeout")
        start("gateway", gateway, args=("--entrypoints.web.address=:8080",
              "--providers.file.filename=/lab-state/gateway.yml", "--log.level=ERROR"), mounts=(state + ",readonly",))
        exit_code = int(administrative("web-wait", "wait", web).strip())
        result.update(status="PASS" if exit_code == 0 else "FAIL", exit_code=exit_code,
                      stage="web-completed")
    except Exception as error:
        # Never serialize subprocess arguments (may contain synthetic signing keys).
        result.update(status="NOTRUN", error_class=type(error).__name__)
    finally:
        # Collection is independent of web liveness and Docker's mount-blind cp.
        if ("container", prefix + "-web") in ownership.resources:
            try:
                ownership.require("volume", prefix)
                current, _ = ownership.inspect("volume", prefix)
                if current != ownership.resources[("volume", prefix)]:
                    raise ValueError("Volume identity changed")
                name = prefix + "-collector"
                argv = ["create", "--pull=never", "--name", name, "--label", f"agent-control.fixture={token}",
                        "--network", "none", "--memory", "128m", "--cpus", "0.5", "--pids-limit", "32",
                        "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only",
                        "--mount", f"type=volume,source={prefix},target=/lab-state,readonly", "--entrypoint", "ruby"]
                if seccomp_compat:
                    argv += ["--security-opt", "seccomp=unconfined"]
                ownership.create("container", name, *argv, image, "-e", COLLECT)
                ownership.require("container", name)
                payload = docker("start", "--attach", name, timeout=30)
                if docker("inspect", "--format", "{{.State.ExitCode}}", name).strip() != "0":
                    raise RuntimeError("Collector failed")
                result["artifact_errors"] = retain_artifacts(payload, out)
                if "report.json" not in result["artifact_errors"]:
                    report = json.loads((out / "report.json").read_text())
                    # Fixed fields only, never bodies, headers, URLs or report text.
                    result["startup"] = [
                        {key: row[key] for key in ("name", "status", "phase", "endpoint", "attempts",
                                                  "http", "reason", "last_error_class") if key in row}
                        for row in report.get("rows", [])
                        if row.get("name") in {"readiness/backend", "readiness/gateway"}]
                if result["artifact_errors"]:
                    result["retention_error"] = True
                elif result["status"] == "PASS" and json.loads((out / "report.json").read_text())["status"] != "PASS":
                    result["status"] = "FAIL"
                    result["report_exit_mismatch"] = True
            except Exception as error:
                result["retention_error"] = True
                result["collector_error_class"] = type(error).__name__
        owned = [name for kind, name in ownership.resources if kind == "container"]
        result["resources"] = ownership.receipt()
        # Logs contain no request bodies/cookies: Rails logger is disabled in harness.
        for name in owned:
            try:
                suffix = name[len(prefix) + 1:] if name.startswith(prefix + "-") else name
                if not name.endswith("-collector"):
                    logs = command(["docker", "logs", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
                    (out / (suffix + ".log")).write_bytes(logs)
                inspect = json.loads(docker("inspect", name))[0]
                # Do not retain Config.Env (signing key). Topology/effective limits only.
                safe = runtime(inspect)
                (out / (suffix + "-runtime.json")).write_text(json.dumps(safe, indent=2))
            except Exception:
                result["retention_error"] = True
        # Persist identities/CIDR and the requested profile before any removal.
        # If this write fails, leave the confirmed resources for recovery rather
        # than destroy their only retained ownership evidence.
        result["cleanup_status"] = "PENDING"
        (out / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
        failures = []
        for name in reversed(owned):
            try:
                ownership.remove("container", name)
            except Exception:
                failures.append(name)
        for kind in ("volume", "network"):
            if (kind, prefix) in ownership.resources:
                try:
                    ownership.remove(kind, prefix)
                except Exception:
                    failures.append(kind + ":" + prefix)
        result["cleanup_failures"] = failures
        result["cleanup_status"] = "FAIL" if failures else "PASS"
        result["gate_status"] = "PASS" if result["status"] == "PASS" and not failures and not result.get("retention_error") else "FAIL"
        (out / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()}
        (out / "sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    print(out.relative_to(ROOT))
    return 0 if result["status"] == "PASS" and not failures and not result.get("retention_error") else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("build", "run"))
    parser.add_argument("--image")
    parser.add_argument("--gateway")
    parser.add_argument("--subnet", help="Explicit RFC1918 IPv4 laboratory CIDR (/24..28)")
    parser.add_argument("--seccomp-compat", action="store_true", help="Laboratory containers only: seccomp=unconfined")
    args = parser.parse_args()
    if args.phase == "build":
        build()
    else:
        if not args.image or not args.gateway or not args.subnet:
            parser.error("run requires --image, --gateway immutable local IDs and --subnet")
        raise SystemExit(run(args.image, args.gateway, args.subnet, args.seccomp_compat))
