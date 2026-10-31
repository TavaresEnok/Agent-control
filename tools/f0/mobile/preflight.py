"""Read-only preflight: does not contact any existing application/service."""
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
node = HERE / ".runtime/node-v22.16.0-linux-x64/bin/node"
browser = next((HERE / '.runtime/browsers').glob('chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'), None)
libraries = ':'.join(str(HERE / '.runtime/browser-libs' / path)
                     for path in ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu'])
missing = []
if browser and shutil.which('ldd'):
    import os
    linked = subprocess.run(['ldd', str(browser)], text=True, capture_output=True,
                            env={**os.environ, 'LD_LIBRARY_PATH': libraries})
    missing = [line.strip() for line in linked.stdout.splitlines() if 'not found' in line]
print(json.dumps({
    "node_in_path": shutil.which("node"),
    "isolated_node": str(node) if node.exists() else None,
    "ruby_in_path": shutil.which("ruby"),
    "rails_runtime": "NOT RUN: no Rails/database/Temporal instance provisioned by this proof",
    "dependencies": (HERE / "node_modules/playwright").exists(),
    "browsers": [p.name for p in (HERE / ".runtime/browsers").glob("chromium*")],
    "install": "python3 tools/f0/mobile/setup.py",
    "missing_browser_libraries": missing,
    "isolated_debian12_libraries": "python3 tools/f0/mobile/browser-libs.py",
    "run": "python3 tools/f0/mobile/run.py",
}, indent=2))
