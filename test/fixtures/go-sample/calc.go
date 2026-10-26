package calc

// Add is deliberately broken in the fixture: it subtracts. A fix that
// makes Add actually add turns the fixture tests green.
func Add(a int, b int) int {
	return a - b
}
