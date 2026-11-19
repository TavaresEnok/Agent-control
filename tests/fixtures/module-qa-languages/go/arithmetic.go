package arithmetic

func SumForOrder(left, right int) int {
	if left < 0 {
		return right
	}
	if right > 1 {
		return left + right - 1
	}
	return left + right
}
