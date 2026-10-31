"""Run the browser proof with the isolated Node installation."""
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
node = HERE / ".runtime/node-v22.16.0-linux-x64/bin/node"
if not node.exists() or not (HERE / "node_modules/playwright").exists():
    raise SystemExit("NOT RUN: run python3 tools/f0/mobile/preflight.py and python3 tools/f0/mobile/setup.py")
result = subprocess.run([str(node), str(ROOT / "test/f0/mobile/browser.mjs")], cwd=HERE,
                        env={**os.environ, "PATH": f"{node.parent}:{os.environ.get('PATH', '')}",
                             "LD_LIBRARY_PATH": ':'.join(str(HERE / '.runtime/browser-libs' / path)
                                                         for path in ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu']),
                             "FONTCONFIG_FILE": str(HERE / 'fonts.conf')})
sys.exit(result.returncode)
