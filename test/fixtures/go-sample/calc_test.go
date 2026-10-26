package calc

import "testing"

func TestAdd(t *testing.T) {
	if got := Add(2, 3); got != 5 {
		t.Fatalf("Add(2, 3) = %d, want 5", got)
	}
}

func TestAddZero(t *testing.T) {
	if got := Add(0, 4); got != 4 {
		t.Fatalf("Add(0, 4) = %d, want 4", got)
	}
}
