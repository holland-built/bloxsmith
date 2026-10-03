package vault

import (
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

type countingListener struct {
	net.Listener
	accepted atomic.Int32
}

func (l *countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.accepted.Add(1)
	}
	return c, err
}

// validateLLMBase blocks the literal address 127.0.0.1 and the name localhost,
// but the operating system also resolves 127.1, 2130706433 (the same address as
// one number, and 2852039166 is the cloud metadata address) and foo.localhost to
// loopback. A base_url spelled any of those passed the check and the server then
// connected to itself. The check now happens where the connection is made, on
// the address that was actually resolved.
func TestLLMTestNeverConnectsToAnInternalAddressWhateverItIsCalled(t *testing.T) {
	for _, host := range []string{"127.1", "2130706433", "foo.localhost", "0x7f.1"} {
		t.Run(host, func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			cl := &countingListener{Listener: ln}
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
			srv.Listener = cl
			srv.StartTLS()
			defer srv.Close()
			_, port, _ := net.SplitHostPort(ln.Addr().String())

			v := New(t.TempDir() + "/vault.json")
			base, model := "https://"+host+":"+port, "m"
			res := v.LLMTest("a-key-of-my-own", &base, &model, "m", "")

			if ok, _ := res["ok"].(bool); ok {
				t.Fatalf("an internal address must not pass the test: %v", res)
			}
			if n := cl.accepted.Load(); n != 0 {
				t.Errorf("the server connected to an internal address (%d connection) because %q was not recognised as one", n, host)
			}
		})
	}
}

func TestRefuseInternalAllowsPublicAddresses(t *testing.T) {
	for addr, wantErr := range map[string]bool{
		"127.0.0.1:443":       true,
		"[::1]:443":           true,
		"169.254.169.254:443": true,
		"10.0.0.5:443":        true,
		"192.168.1.9:443":     true,
		"0.0.0.0:443":         true,
		"93.184.216.34:443":   false,
		"[2606:4700::1]:443":  false,
	} {
		if got := refuseInternal("tcp", addr, nil) != nil; got != wantErr {
			t.Errorf("%s: refused=%v, want %v", addr, got, wantErr)
		}
	}
}
