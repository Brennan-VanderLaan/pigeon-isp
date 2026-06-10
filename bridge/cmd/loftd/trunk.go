// trunk.go — the star control plane between lofts.
//
// Edges dial the gateway's /trunk and forward tokens for frames they buffer;
// the gateway translates edge-local (port, frame) ids into the single id
// space its consumer sees, and turns routing verdicts back into edge-local
// instructions. Payloads take the mesh (/peer, main.go) — the only things on
// a trunk are headers and verdicts.
package main

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ---- gateway side -------------------------------------------------------------

// edgeConn is the gateway's handle on one connected edge loft.
type edgeConn struct {
	node    string
	addr    string // edge's /peer address
	conn    *websocket.Conn
	wmu     sync.Mutex
	portMap map[uint16]uint16 // edge-local port id -> consumer-facing synth id
}

func (e *edgeConn) send7(t byte, a uint16, b uint32) {
	msg := make([]byte, 7)
	msg[0] = t
	binary.BigEndian.PutUint16(msg[1:3], a)
	binary.BigEndian.PutUint32(msg[3:7], b)
	e.wmu.Lock()
	e.conn.WriteMessage(websocket.BinaryMessage, msg)
	e.wmu.Unlock()
}

// sendRemote instructs the edge to push frame fid's payload to addr/dstPort.
func (e *edgeConn) sendRemote(flags uint16, fid uint32, dstPort uint16, addr string) {
	msg := make([]byte, 7+2+1+len(addr))
	msg[0] = msgSendRemote
	binary.BigEndian.PutUint16(msg[1:3], flags)
	binary.BigEndian.PutUint32(msg[3:7], fid)
	binary.BigEndian.PutUint16(msg[7:9], dstPort)
	msg[9] = byte(len(addr))
	copy(msg[10:], addr)
	e.wmu.Lock()
	e.conn.WriteMessage(websocket.BinaryMessage, msg)
	e.wmu.Unlock()
}

// remotePort is an edge's port as seen by the gateway's consumer.
type remotePort struct {
	edge     *edgeConn
	addr     string // edge /peer address (denormalized for routing)
	remoteID uint16
	node     string
	meta     PortMeta
}

func (rp *remotePort) consumerJSON(synthID uint16) map[string]any {
	return map[string]any{
		"id": synthID, "node": rp.node,
		"ifname": rp.meta.Ifname, "mac": rp.meta.MAC, "ip": rp.meta.IP,
		"pod": rp.meta.Pod, "namespace": rp.meta.Namespace,
		"containerId": rp.meta.ContainerID,
	}
}

// remoteFrame is a frame buffered at an edge, known here only by its token.
type remoteFrame struct {
	edge      *edgeConn
	remoteFID uint32
	synthPort uint16
	added     time.Time
}

// serveTrunk handles one edge's lifetime on the gateway.
func (l *Loft) serveTrunk(conn *websocket.Conn) {
	e := &edgeConn{conn: conn, portMap: map[uint16]uint16{}}
	defer l.edgeGone(e)

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.TextMessage {
			var msg struct {
				Type  string          `json:"type"`
				Node  string          `json:"node"`
				Addr  string          `json:"addr"`
				ID    uint16          `json:"id"`
				Port  json.RawMessage `json:"port"`
				Ports json.RawMessage `json:"ports"`
			}
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch msg.Type {
			case "trunk-hello":
				e.node, e.addr = msg.Node, msg.Addr
				l.mu.Lock()
				l.edges[e] = true
				l.mu.Unlock()
				log.Printf("edge %s joined the flock (%s)", e.node, e.addr)
				var ports []struct {
					ID uint16 `json:"id"`
					PortMeta
				}
				json.Unmarshal(msg.Ports, &ports)
				for _, p := range ports {
					l.registerRemotePort(e, p.ID, p.PortMeta)
				}
			case "trunk-port-added":
				var p struct {
					ID uint16 `json:"id"`
					PortMeta
				}
				if json.Unmarshal(msg.Port, &p) == nil {
					l.registerRemotePort(e, p.ID, p.PortMeta)
				}
			case "trunk-port-removed":
				l.mu.Lock()
				synth, ok := e.portMap[msg.ID]
				if ok {
					delete(e.portMap, msg.ID)
					delete(l.remotePorts, synth)
				}
				l.mu.Unlock()
				if ok {
					l.notifyJSON(map[string]any{"type": "port-removed", "id": synth})
				}
			case "trunk-stats":
				var ports map[string]any
				if json.Unmarshal(msg.Ports, &ports) == nil {
					l.mu.Lock()
					l.edgeStats[msg.Node] = ports
					l.mu.Unlock()
				}
			}
			continue
		}

		// Binary from an edge: tokens for frames it buffered.
		if len(data) < 11 || data[0] != msgToken {
			continue
		}
		remotePortID := binary.BigEndian.Uint16(data[1:3])
		remoteFID := binary.BigEndian.Uint32(data[3:7])

		l.mu.Lock()
		synthPort, known := e.portMap[remotePortID]
		if !known || l.client == nil {
			if l.client == nil {
				l.noGame++
			}
			l.mu.Unlock()
			e.send7(msgDrop, 0, remoteFID) // free it at the edge
			continue
		}
		synthFID := l.nextFID
		l.nextFID++
		l.remoteFrames[synthFID] = &remoteFrame{edge: e, remoteFID: remoteFID, synthPort: synthPort, added: time.Now()}
		l.mu.Unlock()

		// Rewrite ids for the consumer, body (len + snapshot) passes through.
		fwd := make([]byte, len(data))
		copy(fwd, data)
		binary.BigEndian.PutUint16(fwd[1:3], synthPort)
		binary.BigEndian.PutUint32(fwd[3:7], synthFID)
		l.sendToRouter(fwd)
		l.broadcastObservers(fwd)
	}
}

func (l *Loft) registerRemotePort(e *edgeConn, remoteID uint16, meta PortMeta) {
	l.mu.Lock()
	if _, dup := e.portMap[remoteID]; dup {
		l.mu.Unlock()
		return
	}
	synth := l.nextID
	l.nextID++
	rp := &remotePort{edge: e, addr: e.addr, remoteID: remoteID, node: e.node, meta: meta}
	l.remotePorts[synth] = rp
	e.portMap[remoteID] = synth
	l.mu.Unlock()
	log.Printf("remote port %d: %s/%s on %s (edge id %d)", synth, meta.Namespace, meta.Pod, e.node, remoteID)
	l.notifyJSON(map[string]any{"type": "port-added", "port": rp.consumerJSON(synth)})
}

// edgeGone tears down everything an edge owned. Its in-flight frames become
// trunk drops — counted, never silent.
func (l *Loft) edgeGone(e *edgeConn) {
	e.conn.Close()
	l.mu.Lock()
	delete(l.edges, e)
	delete(l.edgeStats, e.node)
	var removedSynths []uint16
	for _, synth := range e.portMap {
		delete(l.remotePorts, synth)
		removedSynths = append(removedSynths, synth)
	}
	for fid, rf := range l.remoteFrames {
		if rf.edge == e {
			delete(l.remoteFrames, fid)
			l.dropTrunk++
		}
	}
	l.mu.Unlock()
	if e.node != "" {
		log.Printf("edge %s left the flock", e.node)
	}
	for _, synth := range removedSynths {
		l.notifyJSON(map[string]any{"type": "port-removed", "id": synth})
	}
}

// ---- edge side ------------------------------------------------------------------

// trunkClient is an edge's connection to the gateway.
type trunkClient struct {
	l   *Loft
	url string
	mu  sync.Mutex
	c   *websocket.Conn
}

func (t *trunkClient) connected() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.c != nil
}

func (t *trunkClient) send(data []byte) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.c == nil {
		return false
	}
	if err := t.c.WriteMessage(websocket.BinaryMessage, data); err != nil {
		t.c.Close()
		t.c = nil
		return false
	}
	return true
}

func (t *trunkClient) sendJSON(v any) bool {
	data, _ := json.Marshal(v)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.c == nil {
		return false
	}
	if err := t.c.WriteMessage(websocket.TextMessage, data); err != nil {
		t.c.Close()
		t.c = nil
		return false
	}
	return true
}

func (t *trunkClient) run() {
	for {
		conn, _, err := websocket.DefaultDialer.Dial(t.url, nil)
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		t.mu.Lock()
		t.c = conn
		t.mu.Unlock()

		t.l.mu.Lock()
		ports := make([]*Port, 0, len(t.l.ports))
		for _, p := range t.l.ports {
			ports = append(ports, p)
		}
		t.l.mu.Unlock()
		t.sendJSON(map[string]any{
			"type": "trunk-hello", "node": t.l.node, "addr": t.l.addr, "ports": ports,
		})
		log.Printf("trunked to gateway %s", t.url)

		t.readLoop(conn)

		t.mu.Lock()
		if t.c == conn {
			t.c = nil
		}
		t.mu.Unlock()
		log.Printf("gateway gone, re-trunking…")
		time.Sleep(2 * time.Second)
	}
}

// readLoop handles gateway instructions against our local frames and ports.
func (t *trunkClient) readLoop(conn *websocket.Conn) {
	l := t.l
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.BinaryMessage || len(data) < 7 {
			continue
		}
		a := binary.BigEndian.Uint16(data[1:3])
		b := binary.BigEndian.Uint32(data[3:7])
		switch data[0] {
		case msgDeliver:
			l.deliverLocal(a, b, true)
		case msgCopyDeliver:
			l.deliverLocal(a, b, false)
		case msgDrop:
			l.dropLocal(b)
		case msgSendRemote:
			// [u16 flags][u32 fid][u16 dstPort][u8 addrLen][addr]
			if len(data) < 10 {
				continue
			}
			dstPort := binary.BigEndian.Uint16(data[7:9])
			addrLen := int(data[9])
			if len(data) < 10+addrLen {
				continue
			}
			addr := string(data[10 : 10+addrLen])
			consume := a == 1

			l.mu.Lock()
			f := l.frames[b]
			var payload []byte
			if f != nil {
				if consume {
					delete(l.frames, b)
				} else {
					f.copied = true
				}
				payload = f.data
				if ing := l.byID[f.port]; ing != nil {
					lat := uint64(time.Since(f.added).Microseconds())
					ing.latSumUs += lat
					ing.latCount++
					if lat > ing.latMaxUs {
						ing.latMaxUs = lat
					}
				}
			}
			l.mu.Unlock()
			if payload != nil {
				l.peerSend(addr, dstPort, payload)
			}
		}
	}
}
