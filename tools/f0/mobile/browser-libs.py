"""Download/extract Debian 12 browser libraries locally; never installs packages.

APT configuration, lists, archives, logs and extraction all stay in .runtime.
No maintainer scripts, host package installation, root or services are used.
"""
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / ".runtime"
APT = RUNTIME / "apt"
LIBS = RUNTIME / "browser-libs"
if 'VERSION_ID="12"' not in Path('/etc/os-release').read_text() or 'ID=debian' not in Path('/etc/os-release').read_text():
    raise SystemExit("NOT RUN: local library extraction supports Debian 12 only; ask manager for browser dependencies")
for name in ['lists/partial', 'cache/archives/partial', 'log', 'downloads']:
    (APT / name).mkdir(parents=True, exist_ok=True)
options = [
    '-o', 'Dir::Etc::parts=-', '-o', 'Dir::Etc::main=-',
    '-o', f'Dir::Etc::sourcelist={HERE / "debian.sources.list"}',
    '-o', 'Dir::Etc::sourceparts=-', '-o', f'Dir::State::lists={APT / "lists"}',
    '-o', f'Dir::Cache={APT / "cache"}', '-o', f'Dir::Log={APT / "log"}',
    '-o', 'APT::Sandbox::User=' + os.environ.get('USER', 'enok'),
]
env = {**os.environ, 'APT_CONFIG': str(HERE / 'apt-isolated.conf')}
subprocess.run(['apt-get', *options, 'update'], check=True, env=env)
packages = ['libasound2', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libatspi2.0-0',
            'libcairo2', 'libcups2', 'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0',
            'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1',
            'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0',
            'libxrandr2', 'fonts-liberation']
dependency_output = subprocess.check_output([
    'apt-cache', *options, 'depends', '--recurse', '--no-recommends', '--no-suggests',
    '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances', *packages,
], text=True, env=env)
packages = sorted({line.strip() for line in dependency_output.splitlines()
                   if line and not line[0].isspace() and not line.startswith('<')})
# Keep the host's loader and libc together; the Debian 12 container already supplies them.
packages = [name for name in packages if name not in ['libc6', 'libc-bin', 'gcc-12-base']]
subprocess.run(['apt-get', *options, 'download', *packages], cwd=APT / 'downloads', check=True, env=env)
for archive in sorted((APT / 'downloads').glob('*.deb')):
    subprocess.run(['dpkg-deb', '-x', str(archive), str(LIBS)], check=True)
print(f'Libraries extracted to {LIBS}; run python3 tools/f0/mobile/run.py')
