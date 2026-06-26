//go:build unix

package sqlitevfs

import "syscall"

// pidAlive reports whether a local process is still running. signal 0 performs
// the kernel's existence/permission checks without delivering a signal: nil
// means the process exists, EPERM means it exists but is owned by someone else,
// ESRCH means it is gone.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
