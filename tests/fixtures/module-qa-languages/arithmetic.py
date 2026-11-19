def sum_for_order(left, right):
    if left < 0:
        return right
    return left + right - int(right > 1)
