"""Run standalone F0 guard checks with a disposable Debian Ruby, without sudo.

For this Debian 12 amd64 environment only. Does not install packages, run their
maintainer scripts, access login state, or start any service. A system Ruby can
instead run the test file directly with --disable-gems.
"""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = "https://deb.debian.org/debian/pool/main/r/ruby3.1/"
PACKAGES = {
    "ruby3.1_3.1.2-7+deb12u1_amd64.deb": "714adc8690d962bfa54e9226d59e4c7e9f70e2aec4060ac0a41412a3094bf379",
    "libruby3.1_3.1.2-7+deb12u1_amd64.deb": "5b14a1054f39de3945321637d0ded2b20bbbf1d31108e39d69bfbabe3622f274",
}


def main():
    with tempfile.TemporaryDirectory(prefix=".ruby-", dir=HERE) as directory:
        runtime = Path(directory)
        for name, expected_hash in PACKAGES.items():
            with urllib.request.urlopen(BASE + name, timeout=30) as response:
                data = response.read()
            archive = runtime / name
            if hashlib.sha256(data).hexdigest() != expected_hash:
                raise RuntimeError(f"download checksum mismatch: {name}")
            archive.write_bytes(data)
            print(f"{name} sha256={hashlib.sha256(data).hexdigest()}", flush=True)
            subprocess.run(["dpkg-deb", "--extract", str(archive), str(runtime)], check=True)
        env = {"PATH": "/usr/bin:/bin", "HOME": str(runtime),
               "LD_LIBRARY_PATH": str(runtime / "usr/lib/x86_64-linux-gnu")}
        ruby = str(runtime / "usr/bin/ruby3.1")
        subprocess.run([ruby, "--version"], env=env, check=True)
        subprocess.run([ruby, "--disable-gems", str(ROOT / "test/f0/boundary/integration_eligibility_test.rb")],
                       env=env, cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
