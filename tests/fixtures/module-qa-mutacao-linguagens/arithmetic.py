def total(left, right):
    # Unicode before the operator checks physical column mapping.
    variável = left; return variável + right


def unused(left, right):
    return left * right


def ignored(left, right):
    return left + right  # pragma: no mutate
