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

// lockFreeMarker is what release leaves, because Windows cannot remove a file
// that is open and an empty file counts as busy. With a free OS lock it is free.
const lockFreeMarker = "free"

// releaseLockFile writes before it shortens, so a crash never leaves it empty.
func releaseLockFile(f *os.File, p string) {
	if !sameLockFile(f, p) {
		return
	}
	if _, err := f.WriteAt([]byte(lockFreeMarker), 0); err == nil {
		_ = f.Truncate(int64(len(lockFreeMarker)))
	}
}
