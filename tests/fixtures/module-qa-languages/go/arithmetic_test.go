package arithmetic

import "testing"

func TestControl(t *testing.T) {
	if got := SumForOrder(1, 1); got != 2 {
		t.Errorf("sum = %d, want 2", got)
	}
}

func TestDefect(t *testing.T) {
	if got := SumForOrder(2, 2); got != 4 {
		t.Errorf("sum = %d, want 4", got)
	}
}
