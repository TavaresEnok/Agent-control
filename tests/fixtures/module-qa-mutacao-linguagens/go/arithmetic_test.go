package arithmetic

import "testing"

func TestTotal(t *testing.T) {
	if Total(4, 2) != 6 {
		t.Error("incorrect addition")
	}
}
