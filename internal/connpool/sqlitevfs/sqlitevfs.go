package sqlitevfs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/vfs"
)

const (
	JournalModeDelete = "DELETE"
	JournalModeWAL    = "WAL"
)

type Options struct {
	ReadOnly bool
	// JournalMode, when set, is the journal mode the database is normalized to
	// (e.g. JournalModeDelete). When empty the database keeps its own mode, so a
	// live database's WAL header is never silently rewritten.
	JournalMode string
}

type RemoteFS interface {
	OpenFile(name string, flag int) (RemoteFile, error)
	Remove(name string) error
	Stat(name string) (os.FileInfo, error)
}

type RemoteFile interface {
	io.Closer
	io.ReaderAt
	io.WriterAt
	Truncate(size int64) error
	Sync() error
	Stat() (os.FileInfo, error)
}

var vfsSeq atomic.Int64

func Open(ctx context.Context, remote RemoteFS, remotePath string, opts Options) (*sql.DB, io.Closer, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if remote == nil {
		return nil, nil, errors.New("remote SQLite VFS requires remote filesystem")
	}
	if remotePath == "" || !path.IsAbs(remotePath) {
		return nil, nil, errors.New("remote SQLite path must be absolute")
	}

	var lock *remoteLock
	var err error
	if !opts.ReadOnly {
		lock, err = acquireLock(remote, remotePath+".opskat.lock")
		if err != nil {
			return nil, nil, err
		}
	}

	name := "opskat_sqlite_remote_" + strconv.FormatInt(vfsSeq.Add(1), 10)
	remoteVFS := newRemoteVFS(remote, path.Dir(remotePath), path.Base(remotePath))
	vfs.Register(name, remoteVFS)

	dsn := "file:" + path.Base(remotePath) + "?vfs=" + name
	if opts.ReadOnly {
		dsn += "&mode=ro"
	}
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		vfs.Unregister(name)
		if lock != nil {
			_ = lock.Close()
		}
		return nil, nil, err
	}
	db.SetMaxOpenConns(1)

	// Remote SQLite is single-process: a writer holds the .opskat.lock and the pool
	// is capped at one connection. EXCLUSIVE locking matches that and, crucially, lets
	// SQLite open WAL databases without shared memory ("WAL without shm"). A remote VFS
	// cannot back a real WAL-index — the -shm file is meaningless across hosts — so
	// exclusive locking is the only way to read or write a WAL database. It must run
	// before the database is first read.
	if _, err = db.ExecContext(ctx, "PRAGMA locking_mode=EXCLUSIVE"); err != nil {
		return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("set locking mode: %w", err))
	}

	// Probe the journal mode: this forces the database open now — so an unreadable or
	// missing database fails here with the VFS's detailed error, not on the first query
	// — and tells us the database's current mode.
	var currentJournal string
	if err = db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&currentJournal); err != nil {
		return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("read journal mode: %w", err))
	}

	// Only rewrite the journal mode when a caller explicitly asks for one; otherwise keep
	// the database's own mode so we never silently rewrite a live WAL database's header.
	if opts.JournalMode != "" && !strings.EqualFold(currentJournal, opts.JournalMode) {
		var actualJournal string
		if err = db.QueryRowContext(ctx, "PRAGMA journal_mode="+opts.JournalMode).Scan(&actualJournal); err != nil {
			return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("set journal mode: %w", err))
		}
		if !strings.EqualFold(actualJournal, opts.JournalMode) {
			return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("remote SQLite journal mode %s requested, got %s", opts.JournalMode, actualJournal))
		}
	}
	if _, err = db.ExecContext(ctx, "PRAGMA synchronous=FULL"); err != nil {
		return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("set synchronous: %w", err))
	}
	if opts.ReadOnly {
		if _, err = db.ExecContext(ctx, "PRAGMA query_only=1"); err != nil {
			return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("set query_only: %w", err))
		}
	}
	if err = db.PingContext(ctx); err != nil {
		return nil, nil, cleanupOpenError(db, name, lock, fmt.Errorf("remote SQLite ping: %w", err))
	}

	return db, &closer{vfsName: name, lock: lock}, nil
}

func cleanupOpenError(db *sql.DB, vfsName string, lock *remoteLock, err error) error {
	_ = db.Close()
	vfs.Unregister(vfsName)
	if lock != nil {
		_ = lock.Close()
	}
	return err
}

type closer struct {
	once    sync.Once
	vfsName string
	lock    *remoteLock
}

func (c *closer) Close() error {
	var err error
	c.once.Do(func() {
		vfs.Unregister(c.vfsName)
		if c.lock != nil {
			err = c.lock.Close()
		}
	})
	return err
}

type remoteLock struct {
	remote RemoteFS
	path   string
	file   RemoteFile
}

// lockMeta records who owns a remote lock file. It lets a later session tell an
// orphaned lock (left by a crashed process on this host) apart from one a live
// session still holds, instead of failing every open with an opaque error.
type lockMeta struct {
	Host    string `json:"host"`
	PID     int    `json:"pid"`
	Created int64  `json:"created"` // unix nanoseconds
}

// localHost identifies the machine the current process runs on. Stale detection
// only ever reclaims locks created on this same host (where PID liveness is
// meaningful); locks from other hosts are reported, never taken over.
var localHost = func() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown-host"
	}
	return h
}()

const (
	lockAcquireRetries = 3
	lockMetaMaxBytes   = 4096
)

func acquireLock(remote RemoteFS, lockPath string) (*remoteLock, error) {
	for attempt := 0; ; attempt++ {
		f, err := remote.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
		if err == nil {
			if writeErr := writeLockMeta(f); writeErr != nil {
				_ = f.Close()
				_ = remote.Remove(lockPath)
				return nil, fmt.Errorf("acquire remote SQLite lock: write owner metadata: %w", writeErr)
			}
			return &remoteLock{remote: remote, path: lockPath, file: f}, nil
		}
		// O_EXCL can fail for reasons other than an existing file (permissions,
		// network). Only treat it as "already locked" when the file is really there.
		if _, statErr := remote.Stat(lockPath); statErr != nil {
			return nil, fmt.Errorf("acquire remote SQLite lock: %w", err)
		}
		meta, readErr := readLockMeta(remote, lockPath)
		if readErr == nil && isStaleLock(meta) && attempt < lockAcquireRetries {
			if rmErr := remote.Remove(lockPath); rmErr != nil && !isNotExist(rmErr) {
				return nil, fmt.Errorf("acquire remote SQLite lock: reclaim stale lock %s: %w", lockPath, rmErr)
			}
			continue
		}
		return nil, lockHeldError(lockPath, meta, readErr)
	}
}

func writeLockMeta(f RemoteFile) error {
	payload, err := json.Marshal(lockMeta{Host: localHost, PID: os.Getpid(), Created: time.Now().UnixNano()})
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(payload, 0); err != nil {
		return err
	}
	return f.Sync()
}

func readLockMeta(remote RemoteFS, lockPath string) (lockMeta, error) {
	f, err := remote.OpenFile(lockPath, os.O_RDONLY)
	if err != nil {
		return lockMeta{}, err
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return lockMeta{}, err
	}
	size := fi.Size()
	if size <= 0 || size > lockMetaMaxBytes {
		return lockMeta{}, fmt.Errorf("unexpected lock metadata size %d", size)
	}
	buf := make([]byte, size)
	if _, err := f.ReadAt(buf, 0); err != nil && !errors.Is(err, io.EOF) {
		return lockMeta{}, err
	}
	var meta lockMeta
	if err := json.Unmarshal(buf, &meta); err != nil {
		return lockMeta{}, err
	}
	return meta, nil
}

// isStaleLock reports whether a lock can be safely reclaimed: it must belong to
// this host (so the PID is ours to probe) and reference a process that is gone.
func isStaleLock(meta lockMeta) bool {
	return meta.Host != "" && meta.Host == localHost && !pidAlive(meta.PID)
}

func lockHeldError(lockPath string, meta lockMeta, readErr error) error {
	if readErr != nil {
		return fmt.Errorf("acquire remote SQLite lock: %s is held by another session (owner unreadable: %v); remove it if that session has ended", lockPath, readErr)
	}
	since := "unknown time"
	if meta.Created > 0 {
		since = time.Unix(0, meta.Created).Format(time.RFC3339)
	}
	return fmt.Errorf("acquire remote SQLite lock: database is locked by another session (host=%s pid=%d since %s); remove %s if that session has ended",
		meta.Host, meta.PID, since, lockPath)
}

func (l *remoteLock) Close() error {
	err := l.file.Close()
	if rmErr := l.remote.Remove(l.path); err == nil && rmErr != nil && !isNotExist(rmErr) {
		err = rmErr
	}
	return err
}

type remoteVFS struct {
	remote    RemoteFS
	remoteDir string
	dbName    string

	mu     sync.Mutex
	locks  map[string]vfs.LockLevel
	tempID int
}

func newRemoteVFS(remote RemoteFS, remoteDir, dbName string) *remoteVFS {
	return &remoteVFS{
		remote:    remote,
		remoteDir: remoteDir,
		dbName:    dbName,
		locks:     make(map[string]vfs.LockLevel),
	}
}

func (v *remoteVFS) Open(name string, flags vfs.OpenFlag) (vfs.File, vfs.OpenFlag, error) {
	remotePath := v.resolve(name)
	if name == "" {
		v.mu.Lock()
		v.tempID++
		remotePath = path.Join(v.remoteDir, fmt.Sprintf(".opskat-tmp-%d", v.tempID))
		v.mu.Unlock()
		flags |= vfs.OPEN_CREATE | vfs.OPEN_DELETEONCLOSE
	}

	fileFlags := 0
	switch {
	case flags&vfs.OPEN_READWRITE != 0:
		fileFlags |= os.O_RDWR
	case flags&vfs.OPEN_READONLY != 0:
		fileFlags |= os.O_RDONLY
	default:
		fileFlags |= os.O_RDWR
	}
	if flags&vfs.OPEN_CREATE != 0 {
		fileFlags |= os.O_CREATE
	}
	if flags&vfs.OPEN_EXCLUSIVE != 0 {
		fileFlags |= os.O_EXCL
	}

	f, err := v.remote.OpenFile(remotePath, fileFlags)
	if err != nil {
		return nil, 0, vfs.SystemError(
			fmt.Errorf("open remote SQLite file %s flags=%s: %w", remotePath, formatOpenFlags(fileFlags), err),
			sqlite3.CANTOPEN,
		)
	}
	return &remoteFile{vfs: v, file: f, remotePath: remotePath, deleteOnClose: flags&vfs.OPEN_DELETEONCLOSE != 0}, flags, nil
}

func formatOpenFlags(flags int) string {
	parts := make([]string, 0, 4)
	switch {
	case flags&os.O_RDWR != 0:
		parts = append(parts, "O_RDWR")
	case flags&os.O_WRONLY != 0:
		parts = append(parts, "O_WRONLY")
	default:
		parts = append(parts, "O_RDONLY")
	}
	if flags&os.O_CREATE != 0 {
		parts = append(parts, "O_CREATE")
	}
	if flags&os.O_EXCL != 0 {
		parts = append(parts, "O_EXCL")
	}
	return strings.Join(parts, "|")
}

func (v *remoteVFS) Delete(name string, _ bool) error {
	err := v.remote.Remove(v.resolve(name))
	if isNotExist(err) {
		return sqlite3.IOERR_DELETE_NOENT
	}
	return err
}

func (v *remoteVFS) Access(name string, _ vfs.AccessFlag) (bool, error) {
	_, err := v.remote.Stat(v.resolve(name))
	if isNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (v *remoteVFS) FullPathname(name string) (string, error) {
	if name == "" {
		return "", nil
	}
	return "/" + path.Base(name), nil
}

func (v *remoteVFS) resolve(name string) string {
	clean := path.Clean(strings.TrimPrefix(name, "/"))
	if clean == "." || clean == "" {
		clean = v.dbName
	}
	return path.Join(v.remoteDir, path.Base(clean))
}

type remoteFile struct {
	vfs           *remoteVFS
	file          RemoteFile
	remotePath    string
	deleteOnClose bool
}

func (f *remoteFile) Close() error {
	err := f.file.Close()
	if f.deleteOnClose {
		if rmErr := f.vfs.remote.Remove(f.remotePath); err == nil && rmErr != nil && !isNotExist(rmErr) {
			err = rmErr
		}
	}
	return err
}

func (f *remoteFile) ReadAt(p []byte, off int64) (int, error) {
	return f.file.ReadAt(p, off)
}

func (f *remoteFile) WriteAt(p []byte, off int64) (int, error) {
	return f.file.WriteAt(p, off)
}

func (f *remoteFile) Truncate(size int64) error {
	return f.file.Truncate(size)
}

func (f *remoteFile) Sync(vfs.SyncFlag) error {
	return f.file.Sync()
}

func (f *remoteFile) Size() (int64, error) {
	fi, err := f.file.Stat()
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

func (f *remoteFile) Lock(lock vfs.LockLevel) error {
	f.vfs.mu.Lock()
	defer f.vfs.mu.Unlock()
	if lock > f.vfs.locks[f.remotePath] {
		f.vfs.locks[f.remotePath] = lock
	}
	return nil
}

func (f *remoteFile) Unlock(lock vfs.LockLevel) error {
	f.vfs.mu.Lock()
	defer f.vfs.mu.Unlock()
	if lock == vfs.LOCK_NONE {
		delete(f.vfs.locks, f.remotePath)
		return nil
	}
	f.vfs.locks[f.remotePath] = lock
	return nil
}

func (f *remoteFile) CheckReservedLock() (bool, error) {
	f.vfs.mu.Lock()
	defer f.vfs.mu.Unlock()
	return f.vfs.locks[f.remotePath] >= vfs.LOCK_RESERVED, nil
}

func (f *remoteFile) SectorSize() int {
	return 4096
}

func (f *remoteFile) DeviceCharacteristics() vfs.DeviceCharacteristic {
	return 0
}

func isNotExist(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "no such file")
}
