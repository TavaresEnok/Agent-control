"""Execute the scenario's exact shell check locally; no SSH or physical claim."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]


class SecretAbsenceTest(unittest.TestCase):
    def test_each_central_only_variable_rejects_the_check(self):
        source = (ROOT / "tools/f0/ssh/scenario.rb").read_text()
        commands = re.findall(r'^remote\.call\(%q\((test -z .*?)\)\)$', source, re.M)
        self.assertEqual(1, len(commands), "must test the command used by the scenario")
        for variables, expected_success in [
            ({}, True),
            ({"F0_SYNTHETIC_AI_SECRET": "synthetic-review-probe"}, False),
            ({"SSH_AUTH_SOCK": "/synthetic/review-socket"}, False),
            ({"F0_SYNTHETIC_AI_SECRET": "synthetic-review-probe",
              "SSH_AUTH_SOCK": "/synthetic/review-socket"}, False),
        ]:
            with self.subTest(variables=list(variables)):
                result = subprocess.run(
                    ["/bin/sh", "-c", commands[0]],
                    env={"PATH": "/usr/bin:/bin", **variables},
                    capture_output=True, text=True, timeout=5)
                self.assertEqual(expected_success, result.returncode == 0)


if __name__ == "__main__":
    unittest.main()
