package sqlitevfs

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	. "github.com/smartystreets/goconvey/convey"
)

// writeLockFile drops a lock file with the given owner metadata under the fake
// remote root, mirroring what a previous (possibly crashed) session would leave.
func writeLockFile(t *testing.T, root, host string, pid int, created time.Time) {
	t.Helper()
	lockPath := filepath.Join(root, "data", "app.db.opskat.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	payload := fmt.Sprintf(`{"host":%q,"pid":%d,"created":%d}`, host, pid, created.UnixNano())
	if err := os.WriteFile(lockPath, []byte(payload), 0o600); err != nil {
		t.Fatalf("write lock: %v", err)
	}
}

func TestOpenRemoteSQLiteRejectsForeignHostLock(t *testing.T) {
	Convey("a lock owned by another host is never taken over", t, func() {
		remote := localRemote{root: t.TempDir()}
		writeLockFile(t, remote.root, "some-other-host", os.Getpid(), time.Now())

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldNotBeNil)
		So(db, ShouldBeNil)
		So(closer, ShouldBeNil)
		// The error must name the holder so the user can act, instead of the
		// opaque SSH_FX_FAILURE the bare O_EXCL failure produced.
		So(err.Error(), ShouldContainSubstring, "lock")
		So(err.Error(), ShouldContainSubstring, "some-other-host")

		// The foreign lock file must be left intact.
		_, statErr := os.Stat(filepath.Join(remote.root, "data", "app.db.opskat.lock"))
		So(statErr, ShouldBeNil)
	})
}
