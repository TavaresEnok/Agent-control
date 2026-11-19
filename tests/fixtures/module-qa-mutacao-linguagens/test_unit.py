from unittest import TestCase

from arithmetic import total


class ArithmeticTest(TestCase):
    def test_total(self):
        self.assertEqual(total(4, 2), 6)
