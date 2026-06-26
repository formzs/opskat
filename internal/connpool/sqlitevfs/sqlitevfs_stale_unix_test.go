//go:build unix

package sqlitevfs

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	. "github.com/smartystreets/goconvey/convey"
)

// deadPID returns the PID of a process that has already exited and been reaped,
// so a liveness probe will report it as gone. It launches the test binary with
// a run filter that matches nothing, so the child exits immediately.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$") //nolint:gosec // Re-execs the test binary itself with a constant arg to obtain a reaped PID.
	if err := cmd.Start(); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	_ = cmd.Wait()
	return cmd.Process.Pid
}

func TestOpenRemoteSQLiteTakesOverStaleLock(t *testing.T) {
	Convey("a lock from a dead same-host process is reclaimed", t, func() {
		remote := localRemote{root: t.TempDir()}
		host, err := os.Hostname()
		So(err, ShouldBeNil)
		writeLockFile(t, remote.root, host, deadPID(t), time.Now())

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldBeNil)
		defer func() { _ = closer.Close() }()
		defer func() { _ = db.Close() }()

		_, err = db.Exec("CREATE TABLE t (id INTEGER)")
		So(err, ShouldBeNil)
	})
}
