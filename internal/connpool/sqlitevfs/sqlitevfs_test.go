package sqlitevfs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	. "github.com/smartystreets/goconvey/convey"
)

func TestOpenRemoteSQLiteRollbackReadWrite(t *testing.T) {
	Convey("remote SQLite VFS reads and writes without CGO", t, func() {
		remote := localRemote{root: t.TempDir()}

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldBeNil)
		defer func() { _ = closer.Close() }()
		defer func() { _ = db.Close() }()

		_, err = db.Exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
		So(err, ShouldBeNil)
		_, err = db.Exec("INSERT INTO kv(k, v) VALUES ('alpha', 'one')")
		So(err, ShouldBeNil)
		_, err = db.Exec("UPDATE kv SET v = 'two' WHERE k = 'alpha'")
		So(err, ShouldBeNil)

		var got string
		err = db.QueryRow("SELECT v FROM kv WHERE k = 'alpha'").Scan(&got)
		So(err, ShouldBeNil)
		So(got, ShouldEqual, "two")
		err = db.QueryRow("PRAGMA integrity_check").Scan(&got)
		So(err, ShouldBeNil)
		So(got, ShouldEqual, "ok")

		So(db.Close(), ShouldBeNil)
		So(closer.Close(), ShouldBeNil)

		_, err = os.Stat(filepath.Join(remote.root, "data", "app.db"))
		So(err, ShouldBeNil)
		_, err = os.Stat(filepath.Join(remote.root, "data", "app.db.opskat.lock"))
		So(errors.Is(err, os.ErrNotExist), ShouldBeTrue)
	})
}

func TestOpenRemoteSQLiteReadOnly(t *testing.T) {
	Convey("read-only remote SQLite refuses writes", t, func() {
		remote := localRemote{root: t.TempDir()}

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldBeNil)
		_, err = db.Exec("CREATE TABLE t (id INTEGER)")
		So(err, ShouldBeNil)
		So(db.Close(), ShouldBeNil)
		So(closer.Close(), ShouldBeNil)

		roDB, roCloser, err := Open(context.Background(), remote, "/data/app.db", Options{ReadOnly: true})
		So(err, ShouldBeNil)
		defer func() { _ = roCloser.Close() }()
		defer func() { _ = roDB.Close() }()

		_, err = roDB.Exec("INSERT INTO t VALUES (1)")
		So(err, ShouldNotBeNil)
		So(err.Error(), ShouldContainSubstring, "readonly")
		_, err = os.Stat(filepath.Join(remote.root, "data", "app.db.opskat.lock"))
		So(errors.Is(err, os.ErrNotExist), ShouldBeTrue)
	})
}

func TestOpenRemoteSQLiteLockFileBlocksSecondWriter(t *testing.T) {
	Convey("remote lock file blocks a second writer", t, func() {
		remote := localRemote{root: t.TempDir()}

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldBeNil)
		defer func() { _ = db.Close() }()
		defer func() { _ = closer.Close() }()

		_, secondCloser, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldNotBeNil)
		So(secondCloser, ShouldBeNil)
		So(err.Error(), ShouldContainSubstring, "lock")
	})
}

func TestOpenRemoteSQLiteOpensWALDatabaseReadOnly(t *testing.T) {
	Convey("a WAL-mode remote database opens read-only and is queryable", t, func() {
		remote := localRemote{root: t.TempDir()}

		// Create a WAL-mode database with some data.
		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{JournalMode: JournalModeWAL})
		So(err, ShouldBeNil)
		_, err = db.Exec("CREATE TABLE t (id INTEGER)")
		So(err, ShouldBeNil)
		_, err = db.Exec("INSERT INTO t VALUES (42)")
		So(err, ShouldBeNil)
		var mode string
		So(db.QueryRow("PRAGMA journal_mode").Scan(&mode), ShouldBeNil)
		So(mode, ShouldEqual, "wal")
		So(db.Close(), ShouldBeNil)
		So(closer.Close(), ShouldBeNil)

		// Re-open read-only. This used to fail with
		// "set journal mode: sqlite3: unable to open database file" because the
		// remote VFS provided no shared memory for the WAL-index.
		roDB, roCloser, err := Open(context.Background(), remote, "/data/app.db", Options{ReadOnly: true})
		So(err, ShouldBeNil)
		defer func() { _ = roCloser.Close() }()
		defer func() { _ = roDB.Close() }()

		var got int
		So(roDB.QueryRow("SELECT id FROM t").Scan(&got), ShouldBeNil)
		So(got, ShouldEqual, 42)
		// The database keeps its WAL mode; we did not rewrite the header.
		So(roDB.QueryRow("PRAGMA journal_mode").Scan(&mode), ShouldBeNil)
		So(mode, ShouldEqual, "wal")
	})
}

func TestOpenRemoteSQLiteOpensWALDatabaseReadWrite(t *testing.T) {
	Convey("a WAL-mode remote database opens read-write and keeps its mode", t, func() {
		remote := localRemote{root: t.TempDir()}

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{JournalMode: JournalModeWAL})
		So(err, ShouldBeNil)
		_, err = db.Exec("CREATE TABLE t (id INTEGER)")
		So(err, ShouldBeNil)
		So(db.Close(), ShouldBeNil)
		So(closer.Close(), ShouldBeNil)

		rwDB, rwCloser, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(err, ShouldBeNil)
		defer func() { _ = rwCloser.Close() }()
		defer func() { _ = rwDB.Close() }()

		_, err = rwDB.Exec("INSERT INTO t VALUES (7)")
		So(err, ShouldBeNil)
		var n int
		So(rwDB.QueryRow("SELECT count(*) FROM t").Scan(&n), ShouldBeNil)
		So(n, ShouldEqual, 1)
		var mode string
		So(rwDB.QueryRow("PRAGMA journal_mode").Scan(&mode), ShouldBeNil)
		So(mode, ShouldEqual, "wal")
	})
}

func TestOpenRemoteSQLiteCleansLockOnOpenError(t *testing.T) {
	Convey("open failure after acquiring the remote lock removes the lock file", t, func() {
		remote := localRemote{root: t.TempDir()}

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{JournalMode: "not_a_journal_mode"})
		So(err, ShouldNotBeNil)
		So(db, ShouldBeNil)
		So(closer, ShouldBeNil)

		_, statErr := os.Stat(filepath.Join(remote.root, "data", "app.db.opskat.lock"))
		So(errors.Is(statErr, os.ErrNotExist), ShouldBeTrue)
	})
}

func TestOpenRemoteSQLiteReportsOpenPathAndFlags(t *testing.T) {
	Convey("remote OpenFile failures keep the path and flags in sqlite error text", t, func() {
		remote := failingOpenRemote{localRemote: localRemote{root: t.TempDir()}}

		db, closer, err := Open(context.Background(), remote, "/data/app.db", Options{})
		So(db, ShouldBeNil)
		So(closer, ShouldBeNil)
		So(err, ShouldNotBeNil)
		// locking_mode=EXCLUSIVE is the first statement to touch the file, so a
		// failing remote OpenFile surfaces here — still carrying the path, flags,
		// and underlying cause from the VFS layer.
		So(err.Error(), ShouldContainSubstring, "set locking mode")
		So(err.Error(), ShouldContainSubstring, "/data/app.db")
		So(err.Error(), ShouldContainSubstring, "O_RDWR")
		So(err.Error(), ShouldContainSubstring, "synthetic open failure")
	})
}

type localRemote struct {
	root string
}

func (r localRemote) OpenFile(name string, flag int) (RemoteFile, error) {
	full, err := r.fullPath(name)
	if err != nil {
		return nil, err
	}
	if flag&os.O_CREATE != 0 {
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return nil, err
		}
	}
	return os.OpenFile(full, flag, 0o600) //nolint:gosec // Test helper constrains all requested paths under t.TempDir.
}

func (r localRemote) Remove(name string) error {
	full, err := r.fullPath(name)
	if err != nil {
		return err
	}
	return os.Remove(full)
}

func (r localRemote) Stat(name string) (os.FileInfo, error) {
	full, err := r.fullPath(name)
	if err != nil {
		return nil, err
	}
	return os.Stat(full)
}

func (r localRemote) fullPath(name string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(name))
	if filepath.IsAbs(clean) {
		clean = clean[1:]
	}
	full := filepath.Join(r.root, clean)
	rel, err := filepath.Rel(r.root, full)
	if err != nil {
		return "", err
	}
	if rel == ".." || len(rel) > 3 && rel[:3] == "../" {
		return "", os.ErrPermission
	}
	return full, nil
}

var _ RemoteFS = localRemote{}
var _ RemoteFile = (*os.File)(nil)
var _ io.Closer = (*os.File)(nil)

type failingOpenRemote struct {
	localRemote
}

func (r failingOpenRemote) OpenFile(name string, flag int) (RemoteFile, error) {
	if name == "/data/app.db.opskat.lock" {
		return r.localRemote.OpenFile(name, flag)
	}
	return nil, fmt.Errorf("synthetic open failure")
}
