"""Install only inside this worktree. No sudo, Rails, credentials or services."""
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / ".runtime"
VERSION = "v22.16.0"
NODE = RUNTIME / f"node-{VERSION}-linux-x64" / "bin"


def main():
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("NOT RUN: bootstrap supports Linux x86_64 only")
    RUNTIME.mkdir(exist_ok=True)
    (RUNTIME / "tmp").mkdir(exist_ok=True)
    if not (NODE / "node").exists():
        name = f"node-{VERSION}-linux-x64.tar.xz"
        base = f"https://nodejs.org/dist/{VERSION}/"
        with urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60) as response:
            checksums = response.read().decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name)
        archive = RUNTIME / name
        urllib.request.urlretrieve(base + name, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise SystemExit("Node archive checksum mismatch")
        with tarfile.open(archive) as bundle:
            bundle.extractall(RUNTIME, filter="data")
        archive.unlink()
    env = {**os.environ, "PATH": f"{NODE}:{os.environ.get('PATH', '')}",
           "npm_config_cache": str(RUNTIME / "npm-cache"),
           "npm_config_userconfig": str(RUNTIME / "unused-npmrc"),
           "npm_config_globalconfig": str(RUNTIME / "unused-global-npmrc"),
           "TMPDIR": str(RUNTIME / "tmp"),
           "PLAYWRIGHT_BROWSERS_PATH": str(RUNTIME / "browsers")}
    subprocess.run([str(NODE / "npm"), "ci" if (HERE / "package-lock.json").exists() else "install",
                    "--no-audit", "--no-fund"], cwd=HERE, env=env, check=True)
    subprocess.run([str(NODE / "node"), str(HERE / "node_modules/playwright/cli.js"),
                    "install", "chromium", "--only-shell"], cwd=HERE, env=env, check=True)


if __name__ == "__main__":
    main()
