import unittest

from arithmetic import sum_for_order


class ArithmeticTest(unittest.TestCase):
    def test_control(self):
        self.assertEqual(sum_for_order(1, 1), 2)

    def test_defect(self):
        self.assertEqual(sum_for_order(2, 2), 4)
