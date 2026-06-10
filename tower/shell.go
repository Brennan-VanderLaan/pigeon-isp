// shell — live pod shells over WebSocket, with sessions that OUTLIVE the
// browser. The exec stream is owned by the tower, not the WebSocket: when the
// page reloads (or you close the tab), the shell keeps running and you rejoin
// it — same /bin/sh, same scrollback, same running processes.
//
// A session holds the exec's stdin pipe (so the shell never gets EOF when a
// client detaches), a ring buffer of recent output (replayed on rejoin), and
// at most one attached client at a time.
//
// Endpoints:
//
//	GET /api/shells               — list live sessions {id, pod, ns, attached, age}
//	GET /api/shell?pod=&ns=       — open a NEW session and attach (WebSocket)
//	GET /api/shell?session=<id>   — REJOIN an existing session (WebSocket)
//
// WebSocket framing (unchanged): client binary/text = stdin, except a text
// frame leading with 0x01 + JSON {cols,rows} resizes; server binary = stdout;
// one text "error: ..." on setup failure.
package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

const (
	shellRing       = 256 * 1024       // scrollback replayed on rejoin
	shellIdleExpiry = 30 * time.Minute // detached sessions reaped after this
)

type shellSession struct {
	id  string
	pod string
	ns  string

	mu        sync.Mutex
	stdinW    *io.PipeWriter // tower -> shell stdin (kept open across detaches)
	ring      []byte         // recent output
	client    *websocket.Conn
	clientMu  sync.Mutex // serialize writes to the attached client
	sizes     chan remotecommand.TerminalSize
	lastCols  uint16
	lastRows  uint16
	alive     bool
	detached  time.Time // when the last client left (zero if attached)
	createdAt time.Time
}

type shellRegistry struct {
	mu  sync.Mutex
	m   map[string]*shellSession
	seq int
}

var shells = &shellRegistry{m: map[string]*shellSession{}}

func init() {
	go shells.reaper()
}

func (r *shellRegistry) reaper() {
	for range time.NewTicker(time.Minute).C {
		now := time.Now()
		r.mu.Lock()
		for id, s := range r.m {
			s.mu.Lock()
			idle := !s.detached.IsZero() && now.Sub(s.detached) > shellIdleExpiry
			dead := !s.alive
			s.mu.Unlock()
			if idle || dead {
				s.kill()
				delete(r.m, id)
			}
		}
		r.mu.Unlock()
	}
}

// shells lists live sessions (GET /api/shells).
func shellList(ctx context.Context) (any, error) {
	shells.mu.Lock()
	defer shells.mu.Unlock()
	out := []map[string]any{}
	for _, s := range shells.m {
		s.mu.Lock()
		out = append(out, map[string]any{
			"id": s.id, "pod": s.pod, "ns": s.ns,
			"attached": s.client != nil, "ageS": int(time.Since(s.createdAt).Seconds()),
		})
		s.mu.Unlock()
	}
	return map[string]any{"sessions": out}, nil
}

func shell(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session")
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	if sessionID != "" {
		shells.mu.Lock()
		s := shells.m[sessionID]
		shells.mu.Unlock()
		if s == nil {
			conn.WriteMessage(websocket.TextMessage, []byte("error: session not found (it may have expired)"))
			conn.Close()
			return
		}
		s.attach(conn)
		return
	}

	pod := r.URL.Query().Get("pod")
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		ns = "aviary"
	}
	if pod == "" {
		conn.WriteMessage(websocket.TextMessage, []byte("error: pod query param required"))
		conn.Close()
		return
	}
	s, err := newShellSession(pod, ns)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
		conn.Close()
		return
	}
	conn.WriteMessage(websocket.TextMessage, []byte(`{"session":"`+s.id+`"}`))
	s.attach(conn)
}

func newShellSession(pod, ns string) (*shellSession, error) {
	shells.mu.Lock()
	shells.seq++
	id := "sh-" + strconv.Itoa(shells.seq)
	shells.mu.Unlock()

	pr, pw := io.Pipe()
	s := &shellSession{
		id: id, pod: pod, ns: ns,
		stdinW: pw, sizes: make(chan remotecommand.TerminalSize, 4),
		lastCols: 120, lastRows: 32, alive: true, createdAt: time.Now(),
		detached: time.Now(),
	}

	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Command: []string{"/bin/sh"}, Stdin: true, Stdout: true, Stderr: false, TTY: true,
		}, scheme.ParameterCodec)
	executor, err := remotecommand.NewSPDYExecutor(cfg, "POST", req.URL())
	if err != nil {
		return nil, err
	}

	shells.mu.Lock()
	shells.m[id] = s
	shells.mu.Unlock()

	// The exec runs for the life of the SESSION, fed by the persistent pipe.
	go func() {
		_ = executor.StreamWithContext(context.Background(), remotecommand.StreamOptions{
			Stdin: pr, Stdout: s, Tty: true, TerminalSizeQueue: s,
		})
		s.mu.Lock()
		s.alive = false
		s.mu.Unlock()
		s.broadcast([]byte("\r\n\x1b[90m[shell exited]\x1b[0m\r\n"))
	}()
	return s, nil
}

// Write is the exec's stdout: append to the ring buffer and push to the
// attached client (if any). Implements io.Writer.
func (s *shellSession) Write(p []byte) (int, error) {
	s.mu.Lock()
	s.ring = append(s.ring, p...)
	if len(s.ring) > shellRing {
		s.ring = s.ring[len(s.ring)-shellRing:]
	}
	s.mu.Unlock()
	s.broadcast(p)
	return len(p), nil
}

func (s *shellSession) broadcast(p []byte) {
	s.mu.Lock()
	c := s.client
	s.mu.Unlock()
	if c == nil {
		return
	}
	s.clientMu.Lock()
	c.WriteMessage(websocket.BinaryMessage, p)
	s.clientMu.Unlock()
}

// Next implements TerminalSizeQueue.
func (s *shellSession) Next() *remotecommand.TerminalSize {
	sz, ok := <-s.sizes
	if !ok {
		return nil
	}
	return &sz
}

// attach binds a WebSocket to the session: replay scrollback, then live. On
// disconnect the session SURVIVES (detached), ready to be rejoined.
func (s *shellSession) attach(conn *websocket.Conn) {
	s.mu.Lock()
	if s.client != nil {
		s.client.Close() // one viewer at a time; newest wins
	}
	s.client = conn
	s.detached = time.Time{}
	ring := append([]byte(nil), s.ring...)
	cols, rows := s.lastCols, s.lastRows
	s.mu.Unlock()

	// Replay scrollback so a rejoin shows where you left off.
	s.clientMu.Lock()
	if len(ring) > 0 {
		conn.WriteMessage(websocket.BinaryMessage, ring)
	}
	s.clientMu.Unlock()
	s.pushResize(cols, rows)

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.TextMessage && len(data) > 0 && data[0] == 0x01 {
			var rs struct {
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if json.Unmarshal(data[1:], &rs) == nil && rs.Cols > 0 && rs.Rows > 0 {
				s.mu.Lock()
				s.lastCols, s.lastRows = rs.Cols, rs.Rows
				s.mu.Unlock()
				s.pushResize(rs.Cols, rs.Rows)
			}
			continue
		}
		// stdin
		s.mu.Lock()
		w := s.stdinW
		alive := s.alive
		s.mu.Unlock()
		if !alive {
			break
		}
		if w != nil {
			w.Write(data)
		}
	}

	// Client gone — keep the session, just detach.
	s.mu.Lock()
	if s.client == conn {
		s.client = nil
		s.detached = time.Now()
	}
	s.mu.Unlock()
	conn.Close()
}

func (s *shellSession) pushResize(cols, rows uint16) {
	select {
	case s.sizes <- remotecommand.TerminalSize{Width: cols, Height: rows}:
	default:
	}
}

func (s *shellSession) kill() {
	s.mu.Lock()
	if s.stdinW != nil {
		s.stdinW.Close()
	}
	if s.client != nil {
		s.client.Close()
	}
	s.alive = false
	s.mu.Unlock()
}
