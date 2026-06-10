// shell — a live pod shell over WebSocket, so a browser xterm.js can drive a
// real TTY exec session (k9s/vim/top must render). The aviary CNI keeps these
// pods sandboxed; this just hands you a terminal into one.
//
// Framing (so the xterm client matches):
//
//	client -> server: binary OR text frames are raw stdin bytes, EXCEPT a text
//	  frame whose first byte is 0x01 is a resize control message: 0x01 followed
//	  by JSON {"cols":N,"rows":N}.
//	server -> client: binary frames are stdout bytes. On setup failure the
//	  server writes one text frame "error: ..." then closes.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// CheckOrigin is permissive: the tower is admin-only and in-cluster, and the
// webapp may be served from a different origin/port than the API. Lock down at
// the ingress, not here.
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// resizeMsg is the JSON body of a 0x01 control frame.
type resizeMsg struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// wsStdin is an io.Reader fed by the websocket. Raw frames become stdin; 0x01
// control frames are siphoned off to the resize queue instead.
type wsStdin struct {
	ws    *websocket.Conn
	sizes chan remotecommand.TerminalSize
	buf   []byte // leftover bytes from a frame larger than the read slice
}

func (s *wsStdin) Read(p []byte) (int, error) {
	for len(s.buf) == 0 {
		mt, data, err := s.ws.ReadMessage()
		if err != nil {
			return 0, err // client closed -> EOF the stdin, exec unwinds
		}
		// A text frame starting with 0x01 is a resize, not keystrokes.
		if mt == websocket.TextMessage && len(data) > 0 && data[0] == 0x01 {
			var rs resizeMsg
			if json.Unmarshal(data[1:], &rs) == nil && rs.Cols > 0 && rs.Rows > 0 {
				// non-blocking: drop a resize rather than stall stdin.
				select {
				case s.sizes <- remotecommand.TerminalSize{Width: rs.Cols, Height: rs.Rows}:
				default:
				}
			}
			continue
		}
		s.buf = data
	}
	n := copy(p, s.buf)
	s.buf = s.buf[n:]
	return n, nil
}

// Next implements remotecommand.TerminalSizeQueue. Returns nil (closed) when the
// session ends so client-go stops polling.
func (s *wsStdin) Next() *remotecommand.TerminalSize {
	sz, ok := <-s.sizes
	if !ok {
		return nil
	}
	return &sz
}

// wsStdout is an io.Writer that ships stdout to the browser as binary frames.
// Guarded by a mutex because the gorilla conn isn't safe for concurrent writes.
type wsStdout struct {
	ws *websocket.Conn
	mu *sync.Mutex
}

func (o *wsStdout) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := o.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func shell(w http.ResponseWriter, r *http.Request) {
	pod := r.URL.Query().Get("pod")
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		ns = "aviary"
	}
	if pod == "" {
		http.Error(w, `{"error":"pod query param required"}`, 400)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the HTTP error
	}
	defer ws.Close()

	var writeMu sync.Mutex
	fail := func(msg string) {
		writeMu.Lock()
		ws.WriteMessage(websocket.TextMessage, []byte("error: "+msg))
		writeMu.Unlock()
	}

	// /bin/sh, TTY on. Stderr is folded into stdout by the TTY itself, so we
	// don't wire a separate stderr stream (and TTY exec forbids one anyway).
	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Command: []string{"/bin/sh"},
			Stdin:   true,
			Stdout:  true,
			Stderr:  false,
			TTY:     true,
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(cfg, "POST", req.URL())
	if err != nil {
		fail("exec setup: " + err.Error())
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	stdin := &wsStdin{ws: ws, sizes: make(chan remotecommand.TerminalSize, 4)}
	stdout := &wsStdout{ws: ws, mu: &writeMu}

	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             stdin,
		Stdout:            stdout,
		Tty:               true,
		TerminalSizeQueue: stdin,
	})
	// Closing the size channel lets Next() return and the poll goroutine exit.
	close(stdin.sizes)

	if err != nil && !strings.Contains(err.Error(), "context canceled") {
		// pod-not-found, exec-denied, etc. — tell the user, then the deferred
		// Close drops the socket.
		fail(err.Error())
	}
}
