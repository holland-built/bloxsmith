//go:build windows

package demo

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// tryLockFile takes an exclusive lock on f without waiting. The system drops
// it when f is closed or the process dies.
func tryLockFile(f *os.File) error {
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, new(windows.Overlapped))
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
		return ErrBusy
	}
	return err
}

// releaseLockFile empties the file, because Windows cannot remove a file that
// is open. An empty file with a free lock counts as free.
func releaseLockFile(f *os.File, p string) {
	if sameLockFile(f, p) {
		_ = f.Truncate(0)
	}
}
