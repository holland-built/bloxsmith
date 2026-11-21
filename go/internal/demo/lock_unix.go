//go:build !windows

package demo

import (
	"errors"
	"os"
	"syscall"
)

// tryLockFile takes an exclusive lock on f without waiting. The system drops
// it when f is closed or the process dies.
func tryLockFile(f *os.File) error {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		switch {
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.EWOULDBLOCK):
			return ErrBusy
		}
		return err
	}
}

// releaseLockFile removes the file while f still holds the lock, so an older
// server, which only checks that the file exists, can build again.
func releaseLockFile(f *os.File, p string) {
	if sameLockFile(f, p) {
		_ = os.Remove(p)
	}
}
