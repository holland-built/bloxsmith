// Package provision ports server.py's Phase-1 provisioning engines and their
// lifecycle counterparts (block/site create + compensating rollback, teardown,
// retag, drift) — a faithful, function-by-function port of the ~1,400-line
// orchestration block in server.py (1006-2395), itself a port of Chris
// Marrison's UDDI Automation Toolkit. Every ordered create/rollback step and
// every fail-forward teardown ordering is preserved verbatim; Python is the
// reference and its quirks are matched, not "improved".
//
// Go has no exceptions, so Python's ProvisionError-vs-Exception control flow
// becomes error returns: any non-nil error out of a create step triggers the
// same rollback the Python except-block runs (unless dry-run). Emit-based SSE
// progress is preserved via an Emitter callback the HTTP layer supplies.
package provision

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// Emitter is server.py's emit() SSE callback: it takes one JSON-able object per
// progress event. Non-stream routes pass a no-op (Python's `lambda _obj: None`).
type Emitter func(map[string]any)

// ipNetT aliases net.IPNet so the recursive block builders can name a parent
// network without importing net in every file.
type ipNetT = net.IPNet

// M is the map shape used throughout, matching the edit package.
type M = map[string]any

// Error is the port of ProvisionError (server.py:1011): a controlled failure
// (bad template / failed API call) the HTTP layer turns into a JSON/SSE error
// rather than a 500. Callers distinguish it from an unexpected error exactly as
// Python distinguishes `except ProvisionError` from `except Exception`.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// perr builds a *Error with a formatted message.
func perr(format string, a ...any) *Error { return &Error{Msg: fmt.Sprintf(format, a...)} }

// IsError reports whether err is (or wraps) a *Error — the analogue of Python's
// `except ProvisionError`. The HTTP layer maps it to a 400/SSE-error; anything
// else is an unexpected 500 (Python's `except Exception`).
func IsError(err error) bool {
	var e *Error
	return errors.As(err, &e)
}

// PyStr exports the Python str() coercion for the server layer's body reads.
func PyStr(v any) string { return pyStr(v) }

// Engine holds the shared REST proxy + the templates directory. One per process.
type Engine struct {
	Rest         *rest.Client
	TemplatesDir string
}

// New builds the Engine.
func New(r *rest.Client, templatesDir string) *Engine {
	return &Engine{Rest: r, TemplatesDir: templatesDir}
}

// --- value coercion (YAML yields int; JSON bodies yield float64) -------------

func asMap(v any) M {
	if m, ok := v.(M); ok {
		return m
	}
	return nil
}

func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

// pyStr mirrors Python str() for scalars from YAML/JSON.
func pyStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		return fmt.Sprintf("%v", t)
	}
}

func isFalsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case bool:
		return !t
	case int:
		return t == 0
	case int64:
		return t == 0
	case float64:
		return t == 0
	case []any:
		return len(t) == 0
	case M:
		return len(t) == 0
	default:
		return false
	}
}

// intCoerce is Python int(x): int/float truncates toward zero, numeric string
// parses, else (0,false).
func intCoerce(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case int64:
		return int(t), true
	case float64:
		return int(t), true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// truthy is _truthy (server.py:1342): nil->def; real bool->itself; else
// str(v).strip().lower() not in {"0","false","no",""}.
func truthy(v any, def bool) bool {
	if v == nil {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	switch strings.ToLower(strings.TrimSpace(pyStr(v))) {
	case "0", "false", "no", "":
		return false
	}
	return true
}

// TruthyDry is _truthy_dry (server.py:1355): preview unless explicitly disabled.
func TruthyDry(v any) bool { return truthy(v, true) }

// resolveBool is _resolve_bool (server.py:1361): param (CLI-flag stand-in) wins
// over the YAML value; a real bool()/truthy() on the param, else bool(yaml).
func resolveBool(paramVal, yamlVal any) bool {
	if paramVal != nil && pyStr(paramVal) != "" {
		return truthy(paramVal, false)
	}
	return !isFalsy(yamlVal)
}

// resolve is the params>yaml>fallback precedence helper shared by the config
// builders (server.py:1552/2001): a non-empty param wins, then a non-empty yaml
// value, then the fallback.
func resolve(paramVal, yamlVal any, fallback string) string {
	if paramVal != nil && pyStr(paramVal) != "" {
		return pyStr(paramVal)
	}
	if yamlVal != nil && pyStr(yamlVal) != "" {
		return pyStr(yamlVal)
	}
	return fallback
}

// getMap/getList read a template section as Python's `template.get(k) or {}`.
func getMap(t M, k string) M {
	if m := asMap(t[k]); m != nil {
		return m
	}
	return M{}
}
func getList(t M, k string) []any { return asList(t[k]) }

// --- filter-value escaping (propagates _cspq's ValueError as *Error) ---------

// cspq wraps rest.CSPQ, turning the control-char rejection into a *Error so it
// flows through the same error path Python's `except Exception` catches.
func cspq(v string) (string, error) {
	s, err := rest.CSPQ(v)
	if err != nil {
		return "", perr("%s", err.Error())
	}
	return s, nil
}

// --- IPv4 network helpers (Python ipaddress, strict=False) -------------------

// ipNet parses "addr/cidr" the way ipaddress.ip_network(strict=False) does: the
// returned *net.IPNet.IP is the masked network address.
func ipNet(address string, cidr int) (*net.IPNet, error) {
	_, n, err := net.ParseCIDR(fmt.Sprintf("%s/%d", strings.TrimSpace(address), cidr))
	if err != nil {
		return nil, err
	}
	return n, nil
}

// networkAddr returns the network address as a string (net.network_address).
func networkAddr(n *net.IPNet) string { return n.IP.String() }

// prefixLen returns the mask prefix length.
func prefixLen(n *net.IPNet) int { ones, _ := n.Mask.Size(); return ones }

// isProperSubnet is Python `net.subnet_of(parent) and net != parent`.
func isProperSubnet(child, parent *net.IPNet) bool {
	cOnes := prefixLen(child)
	pOnes := prefixLen(parent)
	if cOnes < pOnes {
		return false
	}
	if !parent.Contains(child.IP) {
		return false
	}
	// equal networks: same prefix and same base address
	if cOnes == pOnes && child.IP.Equal(parent.IP) {
		return false
	}
	return true
}

// addOffset returns the IPv4 address `offset` above the network's base address
// (Python `net.network_address + offset`). IPv4 only, matching the templates.
func addOffset(n *net.IPNet, offset int) (net.IP, bool) {
	v4 := n.IP.To4()
	if v4 == nil {
		return nil, false
	}
	base := binary.BigEndian.Uint32(v4)
	out := make(net.IP, 4)
	binary.BigEndian.PutUint32(out, base+uint32(offset))
	return out, true
}

// ipInNet is Python `ip in net`.
func ipInNet(ip net.IP, n *net.IPNet) bool { return n.Contains(ip) }

// ipLess compares two IP strings numerically for the _block_sort_key min-pick
// (server.py:1619). Unparseable addresses sort last, matching the 1<<128 guard.
func ipKey(addr string) []byte {
	ip := net.ParseIP(strings.TrimSpace(addr))
	if ip == nil {
		return []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
			0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	}
	return append([]byte{0x00}, ip.To16()...)
}
