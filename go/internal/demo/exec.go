package demo

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Cmd is one external command: tofu, ssh, rsync.
type Cmd struct {
	Name  string
	Args  []string
	Dir   string
	Env   []string // added to a minimal environment, never the whole of ours
	Stdin string
}

// Runner runs a command and hands each output line to line. Tests swap it out.
type Runner interface {
	Run(ctx context.Context, c Cmd, line func(string)) error
}

// ExecRunner runs real commands. Output from stdout and stderr is merged.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, c Cmd, line func(string)) error {
	cmd := exec.CommandContext(ctx, c.Name, c.Args...)
	cmd.Dir = c.Dir
	// Only what the tools need. Our own environment can hold other secrets.
	env := []string{}
	for _, k := range []string{"PATH", "HOME", "USER", "LANG", "SSH_AUTH_SOCK", "TMPDIR"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	cmd.Env = append(env, c.Env...)
	if c.Stdin != "" {
		cmd.Stdin = strings.NewReader(c.Stdin)
	}
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line(sc.Text())
		}
		_, _ = io.Copy(io.Discard, pr)
	}()
	err := cmd.Run()
	_ = pw.Close()
	wg.Wait()
	return err
}

// redactor replaces every secret in a line with a fixed mark. Secrets shorter
// than 8 characters are ignored so ordinary words are never blanked out.
type redactor []string

func (r redactor) clean(s string) string {
	for _, sec := range r {
		if len(sec) >= 8 {
			s = strings.ReplaceAll(s, sec, "[hidden]")
		}
	}
	return s
}
