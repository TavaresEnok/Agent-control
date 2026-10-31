"""Host entrypoint guard only: no Docker, SSH, or physical-gate assertion."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]


class HostRunGuardTest(unittest.TestCase):
    def test_requires_two_immutable_image_ids_before_any_resource_creation(self):
        for args in [[], ["image:latest", "target:latest"], ["sha256:" + "a" * 64],
                     ["sha256:" + "a" * 64, "--privileged"]]:
            with self.subTest(args=args):
                result = subprocess.run(
                    [sys.executable, str(ROOT / "tools/f0/ssh/host-run.py"), *args],
                    capture_output=True, text=True, timeout=5)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("Usage:", result.stderr)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
