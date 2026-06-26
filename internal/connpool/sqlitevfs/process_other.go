//go:build !unix

package sqlitevfs

// pidAlive cannot cheaply probe process liveness on non-unix platforms, so it
// conservatively reports any positive PID as alive. This never reclaims a lock
// that might still be held; orphaned locks surface an actionable error instead.
func pidAlive(pid int) bool {
	return pid > 0
}
