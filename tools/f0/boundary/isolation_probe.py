"""Synthetic T24 preparation. Run from any cwd; all fixtures stay in this worktree.

No account discovery, real HOME lookup, credential copying or provider calls.
Namespace mode is a demonstration, not the Aixle launch path or a full sandbox.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def read_attack(path, expected):
    try:
        data = Path(path).read_bytes()
        return "LEAKED" if expected.encode() in data else "BLOCKED_NO_SECRET"
    except (OSError, ValueError):
        return "BLOCKED"


def worker(mode, own, peer, peer_pid, peer_fd, marker):
    if mode == "namespace":
        # Only the disposable peer fixture is mounted over. Never mount on a
        # real account or mutate the host's namespace/mount propagation.
        subprocess.run(["mount", "--make-rprivate", "/"], check=True)
        subprocess.run(["mount", "-t", "tmpfs", "-o", "size=64k", "tmpfs", peer], check=True)
    own = Path(own)
    assert (own / "auth.synthetic").read_text().startswith("SYNTHETIC_ACCOUNT_")
    attempts = {
        "absolute": str(Path(peer) / "auth.synthetic"),
        "symlink": str(own / "peer-link"),
        "process_root": f"/proc/{peer_pid}/root{peer}/auth.synthetic",
        "process_fd": f"/proc/{peer_pid}/fd/{peer_fd}",
        "process_environ": f"/proc/{peer_pid}/environ",
    }
    print(json.dumps({"own_read": True, "attacks": {
        name: read_attack(path, marker) for name, path in attempts.items()
    }, "namespace_executed": mode == "namespace"}))


def probe(mode, own, peer, holder):
    command = [sys.executable, str(Path(__file__).resolve()), "worker", mode,
               str(own), str(peer), str(holder["pid"]), str(holder["fd"]), holder["marker"]]
    if mode == "namespace":
        if not shutil.which("unshare") or not shutil.which("mount"):
            return {"status": "NOT RUN", "cause": "unshare or mount absent", "namespace_executed": False}
        command = ["unshare", "--user", "--map-root-user", "--mount", "--pid", "--fork",
                   "--mount-proc", "--net", *command]
    result = subprocess.run(command, env={"PATH": "/usr/bin:/bin", "HOME": str(own),
                                        "CODEX_HOME": str(own)}, capture_output=True, text=True, timeout=20)
    if result.returncode:
        return {"status": "NOT RUN", "namespace_executed": False, "exit": result.returncode,
                "cause": result.stderr.strip()[-1500:]}
    report = json.loads(result.stdout)
    report["status"] = "LEAK_OBSERVED" if "LEAKED" in report["attacks"].values() else "CROSS_READ_BLOCKED"
    return report


def main():
    holders = []
    with tempfile.TemporaryDirectory(prefix=".probe-", dir=HERE) as directory:
        root = Path(directory)
        accounts = [root / "a", root / "b"]
        identities = []
        try:
            for index, account in enumerate(accounts):
                account.mkdir(mode=0o700)
                marker = f"SYNTHETIC_ACCOUNT_{index}_ONLY_FOR_F0"
                secret = account / "auth.synthetic"
                secret.write_text(marker)
                secret.chmod(0o600)
                # This holder opens only its own generated fixture and waits on
                # stdin; the other account's probes target this exact child PID.
                child = subprocess.Popen([sys.executable, "-c",
                    "import json,os,sys; f=open(sys.argv[1]); "
                    "print(json.dumps({'pid':os.getpid(),'fd':f.fileno()}),flush=True); sys.stdin.read()",
                    str(secret)], env={"PATH": "/usr/bin:/bin", "HOME": str(account),
                                      "CODEX_HOME": str(account), "F0_SYNTHETIC_SECRET": marker},
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                holders.append(child)
                identity = json.loads(child.stdout.readline())
                identity["marker"] = marker
                identities.append(identity)
            for index, account in enumerate(accounts):
                (account / "peer-link").symlink_to(accounts[1-index] / "auth.synthetic")
            report = {"synthetic_only": True, "real_codex": "NOT RUN",
                      "uid": os.getuid(), "concurrent_synthetic_holders": len(holders),
                      "kernel": os.uname().release}
            for mode in ("home_only", "namespace"):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(probe, mode, accounts[i], accounts[1-i], identities[1-i])
                               for i in range(2)]
                    report[mode] = [future.result() for future in futures]
            print(json.dumps(report, indent=2))
        finally:
            for child in holders:
                child.communicate(timeout=5)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "worker":
        worker(*sys.argv[2:])
    else:
        main()
