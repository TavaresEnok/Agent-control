"""Manager-only Docker operation. No compose, Docker socket mount or host mutation.

build: filtered source context; online downloads with NO services.
run: local immutable image IDs only; exclusive internal network; no published ports.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
BASE = "ruby@sha256:32fdd19c0a001077d1711f1afa6d8a0ac9d497c4eac20e47ae7e1c7f7a8c49df"
PG = "postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a"


def source_paths():
    # Never send .env, credentials, .git, artifacts, existing auth, or node_modules.
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    names += [str(p.relative_to(ROOT)) for p in (ROOT / "tools/f0/access").glob("*") if p.is_file()]
    build_tests = {"test/f0/access/mcp_evidence_test.rb", "test/f0/access/session_cookie_test.rb"}
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


def run(image, gateway):
    image, gateway, pg = map(immutable, (image, gateway, PG))
    token = secrets.token_hex(12)
    prefix = "f0-access-" + token
    out = ROOT / "docs/validation/artifacts/access" / prefix
    out.mkdir(parents=True, mode=0o700)
    owned = []
    network = volume = False
    result = {"status": "NOTRUN", "fixture": token, "images": [image, gateway, pg]}

    def docker(*args):
        return command(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode()

    def start(suffix, img, args=(), env=(), mounts=()):
        name = prefix + "-" + suffix
        # Only ever delete successfully created, uniquely named resources.
        argv = ["create", "--pull=never", "--name", name, "--label", f"agent-control.fixture={token}",
                "--network", prefix, "--network-alias", suffix, "--memory", "2g" if suffix == "web" else "512m",
                "--cpus", "2" if suffix == "web" else "1", "--pids-limit", "256", "--cap-drop=ALL",
                "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid"]
        for entry in env:
            argv += ["-e", entry]
        for mount in mounts:
            argv += ["--mount", mount]
        if suffix == "pg":
            argv += ["--user", "postgres"]
        docker(*argv, img, *args)
        owned.append(name)
        # A failed start still leaves a container: retain and remove it in finally.
        # A failed create (including a name collision) never establishes ownership.
        docker("start", name)
        return name

    try:
        for kind, name in [("network", prefix), ("volume", prefix)] + [("container", prefix + "-" + s) for s in ("pg", "web", "gateway", "terminal")]:
            try:
                docker(kind, "inspect", name)
            except subprocess.CalledProcessError:
                pass
            else:
                raise RuntimeError("Preexisting resource refused")
        docker("network", "create", "--internal", "--label", f"agent-control.fixture={token}", prefix)
        network = True
        docker("volume", "create", "--label", f"agent-control.fixture={token}", prefix)
        volume = True
        state = f"type=volume,source={prefix},target=/lab-state"
        pg_name = start("pg", pg, env=("POSTGRES_USER=f0_access_lab", "POSTGRES_DB=postgres",
                        "POSTGRES_HOST_AUTH_METHOD=trust", "PGDATA=/tmp/pgdata"))
        for _ in range(40):
            try:
                docker("exec", pg_name, "pg_isready", "-U", "f0_access_lab", "-d", "postgres")
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise RuntimeError("Disposable PG readiness failed")
        # CREATE DATABASE refuses a preexisting database. No IF NOT EXISTS, drop, migrate or seeds.
        docker("exec", pg_name, "psql", "-U", "f0_access_lab", "-d", "postgres", "-v", "ON_ERROR_STOP=1",
               "-c", "CREATE DATABASE aixle_test OWNER f0_access_lab")
        comment = f"agent-control:access:disposable:{token}"
        docker("exec", pg_name, "psql", "-U", "f0_access_lab", "-d", "postgres", "-v", "ON_ERROR_STOP=1",
               "-c", f"COMMENT ON DATABASE aixle_test IS '{comment}'")
        start("terminal", image, args=("ttyd", "-W", "-p", "7681", "sh", "-c",
              "printf SYNTHETIC_TTYD_ACCESS; sleep 30"))
        env = ("RAILS_ENV=test", "BUNDLE_FROZEN=true", "DB_HOST=pg", "DB_USERNAME=f0_access_lab",
               "DB_PASSWORD=", "F0_ACCESS_TOKEN=" + token, "RAILS_SECRET_KEY_BASE=" + secrets.token_hex(64),
               "DOMAIN=web:4000", "PROTOCOL=http", "SOLID_QUEUE_IN_PUMA=false", "MITM_DISABLED=true",
               "HOME=/tmp", "BOOTSNAP_CACHE_DIR=/tmp/bootsnap", "RAILS_LOG_TO_STDOUT=true")
        web = start("web", image, env=env, mounts=(state,))
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
        exit_code = int(docker("wait", web).strip())
        # Retain reports before cleanup. Raw cookies/tokens never leave tmpfs/volume.
        docker("cp", web + ":/lab-state/report.json", str(out / "report.json"))
        docker("cp", web + ":/lab-state/gateway.yml", str(out / "gateway.yml"))
        result.update(status="PASS" if exit_code == 0 else "FAIL", exit_code=exit_code)
    except Exception as error:
        # Never serialize subprocess arguments (may contain synthetic signing keys).
        result.update(status="NOTRUN", error_class=type(error).__name__)
    finally:
        # Logs contain no request bodies/cookies: Rails logger is disabled in harness.
        for name in owned:
            try:
                logs = command(["docker", "logs", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
                (out / (name.removeprefix(prefix + "-") + ".log")).write_bytes(logs)
                if name.endswith("-web"):
                    for artifact in ("report.json", "gateway.yml"):
                        try:
                            docker("cp", name + ":/lab-state/" + artifact, str(out / artifact))
                        except subprocess.CalledProcessError:
                            result["missing_" + artifact] = True
                inspect = json.loads(docker("inspect", name))[0]
                # Do not retain Config.Env (signing key). Topology/effective limits only.
                safe = {k: inspect[k] for k in ("NetworkSettings", "State")}
                safe["limits"] = {k: inspect["HostConfig"][k] for k in ("Memory", "NanoCpus", "PidsLimit", "PortBindings")}
                (out / (name.removeprefix(prefix + "-") + "-runtime.json")).write_text(json.dumps(safe, indent=2))
            except Exception:
                result["retention_error"] = True
        failures = []
        for name in reversed(owned):
            try:
                docker("rm", "-f", name)
            except Exception:
                failures.append(name)
        for kind, created in (("volume", volume), ("network", network)):
            if created:
                try:
                    docker(kind, "rm", prefix)
                except Exception:
                    failures.append(kind + ":" + prefix)
        result["cleanup_failures"] = failures
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
    args = parser.parse_args()
    if args.phase == "build":
        build()
    else:
        if not args.image or not args.gateway:
            parser.error("run requires --image and --gateway immutable local IDs")
        raise SystemExit(run(args.image, args.gateway))
