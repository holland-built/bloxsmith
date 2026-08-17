package main

import (
	"errors"
	"io/fs"
	"os"
)

// A LOOKUP THAT FAILED IS NOT AN ABSENCE.
//
// `if _, err := os.Stat(x); err == nil { … }` puts "it is not there" and "I could
// not look" in the same branch. Every refuse-to-clobber guard in this binary was
// written that way, so a path the process could not stat — EACCES on a parent, a
// symlink loop, EIO — counted as a clear target and the guard silently did not
// fire. Measured on vault-restore: a state dir at mode 0300 (write and traverse, no
// read) is enough to restore INTO and not enough to list, and the "refusing, not
// empty" guard was skipped over a live install with no warning (#129).
//
// WHY --force DOES NOT OVERRIDE AN INDETERMINATE ANSWER, decided rather than left
// open: --force's promise is about known files — vault-restore's own text says it
// "does NOT wipe the directory: anything not named in the archive is left where it
// is". That is a promise about contents, and it cannot be made about a directory
// the process cannot read. So a stat or listing failure refuses regardless of
// --force, and the message says the error rather than implying --force would help.

// pathAbsent reports whether path is known NOT to exist.
//
// (false, nil) it exists · (true, nil) it does not · (false, err) unknown, and err
// is the reason. The third case is the one this function exists to make impossible
// to ignore: a caller that only checks the bool still gets `false`, which routes an
// unknown path to the same branch as an existing one — the safe direction for every
// refuse-to-clobber guard here.
func pathAbsent(path string) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if errors.Is(err, fs.ErrNotExist) {
		return true, nil
	} else {
		return false, err
	}
}

// dirEntries lists a directory, telling "not there yet" apart from "could not
// look".
//
// (nil, true, nil) it does not exist · (entries, false, nil) it does · (nil, false,
// err) unknown. errors.Is against fs.ErrNotExist is the classification the io/fs
// contract provides; no preliminary stat is needed, and a stat-then-list would only
// widen the window between the two answers.
func dirEntries(dir string) ([]fs.DirEntry, bool, error) {
	entries, err := os.ReadDir(dir)
	if err == nil {
		return entries, false, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil, true, nil
	}
	return nil, false, err
}
