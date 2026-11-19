from hypothesis import given, settings, strategies as st

from arithmetic import total


def test_total():
    assert total(4, 2) == 6


@given(value=st.integers(min_value=-100, max_value=100))
@settings(max_examples=100)
def test_neutral_element(value):
    assert total(value, 0) == value


@given(left=st.integers(min_value=-100, max_value=100),
       right=st.integers(min_value=-100, max_value=100))
def test_commutes(left, right):
    assert total(left, right) == total(right, left)
