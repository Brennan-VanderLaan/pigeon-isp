// loftd — the pigeon loft daemon.
//
// One loftd per node owns that node's aviary veths (AF_PACKET taps) and the
// frames buffered off them. Multi-node works as STAR CONTROL PLANE, MESH DATA
// PLANE:
//
//   - The gateway loft (control-plane node) is the Pigeon API endpoint.
//     Consumers attach there and see the union of every node's ports; tokens
//     and routing verdicts flow through it (~tens of bytes per frame).
//   - Payloads NEVER transit the gateway or the consumer. A cross-node
//     delivery is an instruction to the ingress loft ("frame 4182 → node B,
//     port 3"), which pushes the payload straight to the egress loft over the
//     standard node network (/peer). Flow offload later reuses this exact
//     path with no tokens at all.
//
// Consumer protocol (ws /ws) is unchanged from single-node — the cluster
// growing is invisible to consumers except ports gaining a "node" field.
// `?mode=observe` attaches a read-only consumer: it sees tokens, ports and
// stats but cannot route; the router role stays exclusive (latest wins).
//
// Text control messages to the consumer: hello / port-added / port-removed /
// stats, plus {"type":"log","who","line"} — operational narration the loft
// genuinely sees (attach greeting, buffer backpressure, peer health). It does
// NOT narrate ARP/ping: the loft routes on headers, it doesn't interpret them.
//
// The no-silent-drop rule (docs/pigeon-api.md): every frame ends delivered or
// in a named drop counter — consumer, ttl, overflow, no-consumer, trunk.
//
// Wire protocol (binary, big-endian; 7-byte header [u8 type][u16 a][u32 b]):
//
//	0x01 token        loft -> consumer/gateway  + [u32 fullLen][snapshot]
//	0x02 deliver      consumer/gateway -> loft     a=egressPort b=frameId
//	0x03 drop         consumer/gateway -> loft     b=frameId
//	0x04 copy-deliver consumer/gateway -> loft     deliver without consuming
//	0x14 inject       loft -> loft (/peer)         a=egressPort + [payload]
//	0x15 send-remote  gateway -> edge              a=flags(1=consume) b=frameId
//	                  + [u16 dstPort][u8 addrLen][addr] — push payload to peer
//	0x10/0x11 offload-add/remove: reserved for the fast path.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/sys/unix"
)

const (
	msgToken       = 0x01
	msgDeliver     = 0x02
	msgDrop        = 0x03
	msgCopyDeliver = 0x04
	msgInject      = 0x14
	msgSendRemote  = 0x15

	protocolVersion = 1

	maxFrame    = 9216
	snapshotLen = 128
	bufTTL      = 30 * time.Second
	maxBuffered = 8192
	statsPeriod = time.Second
)

// PortMeta is written by pigeon-cni to <portsDir>/<ifname>.json.
type PortMeta struct {
	Ifname      string `json:"ifname"`
	MAC         string `json:"mac"`
	IP          string `json:"ip"`
	Pod         string `json:"pod"`
	Namespace   string `json:"namespace"`
	ContainerID string `json:"containerId"`
}

type Port struct {
	ID   uint16 `json:"id"`
	Node string `json:"node"`
	PortMeta
	fd      int
	ifindex int
	done    chan struct{}

	// Virtual ports have no veth: their wire is a WebSocket to an external
	// agent (perch, a VPN gateway, …). Egress writes go to the agent; ingress
	// frames arrive over the same socket. scanLoop ignores them.
	virtual bool
	agent   *websocket.Conn
	agentMu sync.Mutex

	rxFrames, rxBytes, txFrames, txBytes               uint64
	dropsOverflow, dropsTTL, dropsConsumer, dropsTrunk uint64
	latSumUs, latCount, latMaxUs                       uint64
}

type bufFrame struct {
	port   uint16
	data   []byte
	added  time.Time
	copied bool
}

type peerConn struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	lastLog time.Time // rate-limit "peer unreachable" narration
}

type Loft struct {
	mu   sync.Mutex
	node string // node name, stamped on ports
	addr string // host:port other lofts can reach us at (/peer)

	ports   map[string]*Port // by ifname
	byID    map[uint16]*Port // by port id
	nextID  uint16
	frames  map[uint32]*bufFrame
	nextFID uint32

	client    *websocket.Conn // the router consumer (exclusive)
	cwmu      sync.Mutex
	observers map[*websocket.Conn]*sync.Mutex
	noGame    uint64 // frames dropped: no router consumer anywhere
	dropTrunk uint64 // frames lost to trunk/peer failures

	// onLog narration to the consumer. Edge-triggered so a sustained overflow
	// logs once, not once per shed frame.
	overflowing     bool
	lastOverflowLog time.Time

	// gateway role
	isGateway    bool
	edges        map[*edgeConn]bool
	remotePorts  map[uint16]*remotePort
	remoteFrames map[uint32]*remoteFrame
	edgeStats    map[string]map[string]any // node -> pod -> stats

	// edge role
	trunk *trunkClient

	// mesh data plane: peer lofts by addr
	peers map[string]*peerConn
}

func main() {
	listen := flag.String("listen", ":9777", "websocket listen address")
	portsDir := flag.String("ports-dir", "/run/pigeon/ports", "directory pigeon-cni writes port metadata into")
	node := flag.String("node", "", "this node's name")
	nodeIP := flag.String("node-ip", "", "this node's IP (peer-reachable)")
	gateway := flag.String("gateway", "", "gateway loft host:port; empty or self = act as gateway")
	flag.Parse()

	port := strings.TrimPrefix(*listen, ":")
	l := &Loft{
		node:         *node,
		addr:         net.JoinHostPort(*nodeIP, port),
		ports:        map[string]*Port{},
		byID:         map[uint16]*Port{},
		nextID:       1,
		frames:       map[uint32]*bufFrame{},
		nextFID:      1,
		observers:    map[*websocket.Conn]*sync.Mutex{},
		edges:        map[*edgeConn]bool{},
		remotePorts:  map[uint16]*remotePort{},
		remoteFrames: map[uint32]*remoteFrame{},
		edgeStats:    map[string]map[string]any{},
		peers:        map[string]*peerConn{},
	}
	gwHost, _, _ := net.SplitHostPort(*gateway)
	if gwHost == "" {
		gwHost = *gateway
	}
	l.isGateway = *gateway == "" || gwHost == *nodeIP
	role := "edge"
	if l.isGateway {
		role = "gateway"
	}

	if err := os.MkdirAll(*portsDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", *portsDir, err)
	}
	go l.scanLoop(*portsDir)
	go l.housekeeping()
	if !l.isGateway {
		l.trunk = &trunkClient{l: l, url: "ws://" + *gateway + "/trunk"}
		go l.trunk.run()
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		l.attachConsumer(conn, r.URL.Query().Get("mode") == "observe")
	})
	http.HandleFunc("/trunk", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		l.serveTrunk(conn)
	})
	http.HandleFunc("/peer", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		l.servePeer(conn)
	})
	// External agents (perch, VPN gateways) register a virtual host here.
	http.HandleFunc("/port", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		l.servePort(conn)
	})
	http.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		stats := l.statsLocked()
		l.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	})
	// /hosts: the live name->IP registry of every roosted host (local + remote),
	// so the uplink's DNS resolver can answer <pod>.<domain> on the pigeon net.
	http.HandleFunc("/hosts", func(w http.ResponseWriter, r *http.Request) {
		type host struct {
			Name      string `json:"name"`
			IP        string `json:"ip"`
			Namespace string `json:"namespace"`
		}
		l.mu.Lock()
		out := []host{}
		for _, p := range l.ports {
			out = append(out, host{p.Pod, p.IP, p.Namespace})
		}
		for _, rp := range l.remotePorts {
			out = append(out, host{rp.meta.Pod, rp.meta.IP, rp.meta.Namespace})
		}
		l.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"hosts": out})
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		out := map[string]any{
			"loft": "open", "node": l.node, "role": role,
			"ports": len(l.ports), "remotePorts": len(l.remotePorts),
			"edges": len(l.edges), "buffered": len(l.frames),
			"droppedNoConsumer": l.noGame, "droppedTrunk": l.dropTrunk,
		}
		l.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	})

	log.Printf("loftd[%s]: the loft is open on %s as %s (addr %s)", l.node, *listen, role, l.addr)
	log.Fatal(http.ListenAndServe(*listen, nil))
}

// ---- port lifecycle ---------------------------------------------------------

func (l *Loft) scanLoop(dir string) {
	for {
		seen := map[string]bool{}
		entries, err := os.ReadDir(dir)
		if err == nil {
			for _, e := range entries {
				if !strings.HasSuffix(e.Name(), ".json") {
					continue
				}
				ifname := strings.TrimSuffix(e.Name(), ".json")
				seen[ifname] = true
				l.mu.Lock()
				_, known := l.ports[ifname]
				l.mu.Unlock()
				if !known {
					if err := l.addPort(filepath.Join(dir, e.Name()), ifname); err != nil {
						log.Printf("addPort %s: %v", ifname, err)
					}
				}
			}
		}
		l.mu.Lock()
		var gone []*Port
		for name, p := range l.ports {
			if p.virtual {
				continue // agents manage their own lifecycle via /port
			}
			if !seen[name] {
				gone = append(gone, p)
				delete(l.ports, name)
				delete(l.byID, p.ID)
			}
		}
		l.mu.Unlock()
		for _, p := range gone {
			close(p.done)
			unix.Close(p.fd)
			log.Printf("port %d (%s, pod %s) flew away", p.ID, p.Ifname, p.Pod)
			l.notifyJSON(map[string]any{"type": "port-removed", "id": p.ID})
			if l.trunk != nil {
				l.trunk.sendJSON(map[string]any{"type": "trunk-port-removed", "id": p.ID})
			}
		}
		time.Sleep(time.Second)
	}
}

func (l *Loft) addPort(metaPath, ifname string) error {
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return err
	}
	var meta PortMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return err
	}
	iface, err := net.InterfaceByName(ifname)
	if err != nil {
		return err
	}

	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW|unix.SOCK_CLOEXEC, int(htons(unix.ETH_P_ALL)))
	if err != nil {
		return err
	}
	sll := &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_ALL), Ifindex: iface.Index}
	if err := unix.Bind(fd, sll); err != nil {
		unix.Close(fd)
		return err
	}
	mreq := &unix.PacketMreq{Ifindex: int32(iface.Index), Type: unix.PACKET_MR_PROMISC}
	if err := unix.SetsockoptPacketMreq(fd, unix.SOL_PACKET, unix.PACKET_ADD_MEMBERSHIP, mreq); err != nil {
		log.Printf("promisc on %s: %v (continuing)", ifname, err)
	}

	l.mu.Lock()
	id := l.nextID
	l.nextID++
	p := &Port{ID: id, Node: l.node, PortMeta: meta, fd: fd, ifindex: iface.Index, done: make(chan struct{})}
	l.ports[ifname] = p
	l.byID[id] = p
	l.mu.Unlock()

	log.Printf("port %d roosted: %s pod=%s/%s ip=%s mac=%s", id, ifname, meta.Namespace, meta.Pod, meta.IP, meta.MAC)
	l.notifyJSON(map[string]any{"type": "port-added", "port": p})
	if l.trunk != nil {
		l.trunk.sendJSON(map[string]any{"type": "trunk-port-added", "port": p})
	}
	go l.readLoop(p)
	return nil
}

// ---- frame ingress ----------------------------------------------------------

func (l *Loft) readLoop(p *Port) {
	buf := make([]byte, maxFrame)
	for {
		select {
		case <-p.done:
			return
		default:
		}
		n, from, err := unix.Recvfrom(p.fd, buf, 0)
		if err != nil {
			select {
			case <-p.done:
			default:
				log.Printf("recv on %s: %v", p.Ifname, err)
			}
			return
		}
		if sll, ok := from.(*unix.SockaddrLinklayer); ok && sll.Pkttype == unix.PACKET_OUTGOING {
			continue
		}
		l.ingest(p, buf[:n])
	}
}

// ingest releases one frame (from a veth or an agent) into the loft: buffer
// it and tokenize to the consumer. Shared by veth readLoop and /port agents.
func (l *Loft) ingest(p *Port, frame []byte) {
	if len(frame) < 14 {
		return
	}
	l.mu.Lock()
	p.rxFrames++
	p.rxBytes += uint64(len(frame))
	haveRouter := l.client != nil
	haveTrunk := l.trunk != nil && l.trunk.connected()
	if !haveRouter && !haveTrunk {
		l.noGame++
		l.mu.Unlock()
		return // the router doesn't exist; the frame never happened
	}
	if len(l.frames) >= maxBuffered {
		p.dropsOverflow++
		// Log the ONSET of shedding (edge-triggered, min 2s apart) so a
		// consumer sees backpressure without a per-frame firehose under load.
		onset := !l.overflowing && time.Since(l.lastOverflowLog) > 2*time.Second
		if onset {
			l.overflowing = true
			l.lastOverflowLog = time.Now()
		}
		l.mu.Unlock()
		if onset {
			l.notifyLog("loft", fmt.Sprintf("buffer full (%d frames): shedding load — drops.overflow is climbing", maxBuffered))
		}
		return
	}
	fid := l.nextFID
	l.nextFID++
	data := make([]byte, len(frame))
	copy(data, frame)
	l.frames[fid] = &bufFrame{port: p.ID, data: data, added: time.Now()}
	// Recovered once the consumer has drained us well below the line (hysteresis
	// at 3/4 so we don't flap onset/recovery around the threshold).
	drained := l.overflowing && len(l.frames) < maxBuffered*3/4
	if drained {
		l.overflowing = false
	}
	l.mu.Unlock()
	if drained {
		l.notifyLog("loft", "buffer drained: accepting frames again")
	}

	tok := buildToken(p.ID, fid, uint32(len(data)), data)
	if haveRouter {
		l.sendToRouter(tok)
	} else {
		l.trunk.send(tok)
	}
	l.broadcastObservers(tok)
}

func buildToken(port uint16, fid, fullLen uint32, data []byte) []byte {
	snap := len(data)
	if snap > snapshotLen {
		snap = snapshotLen
	}
	msg := make([]byte, 11+snap)
	msg[0] = msgToken
	binary.BigEndian.PutUint16(msg[1:3], port)
	binary.BigEndian.PutUint32(msg[3:7], fid)
	binary.BigEndian.PutUint32(msg[7:11], fullLen)
	copy(msg[11:], data[:snap])
	return msg
}

// ---- local frame ops --------------------------------------------------------

// deliverLocal writes a locally-buffered frame to a local port.
func (l *Loft) deliverLocal(portID uint16, fid uint32, consume bool) {
	l.mu.Lock()
	f := l.frames[fid]
	target := l.byID[portID]
	var data []byte
	if f != nil && target != nil {
		if consume {
			delete(l.frames, fid)
		} else {
			f.copied = true
		}
		data = f.data
		l.countDeliverLocked(target, f)
	}
	l.mu.Unlock()
	if data == nil || target == nil {
		return
	}
	l.writeOut(target, data)
}

// countDeliverLocked updates tx + latency counters; caller holds l.mu.
func (l *Loft) countDeliverLocked(target *Port, f *bufFrame) {
	target.txFrames++
	target.txBytes += uint64(len(f.data))
	lat := uint64(time.Since(f.added).Microseconds())
	// Latency is attributed to the frame's INGRESS port: arrival -> verdict.
	if ing := l.byID[f.port]; ing != nil {
		ing.latSumUs += lat
		ing.latCount++
		if lat > ing.latMaxUs {
			ing.latMaxUs = lat
		}
	}
}

func (l *Loft) writeOut(target *Port, frame []byte) {
	if target.virtual {
		// Egress to an external agent: ship the raw frame over its socket.
		target.agentMu.Lock()
		c := target.agent
		target.agentMu.Unlock()
		if c != nil {
			target.agentMu.Lock()
			c.WriteMessage(websocket.BinaryMessage, frame)
			target.agentMu.Unlock()
		}
		return
	}
	sll := &unix.SockaddrLinklayer{Ifindex: target.ifindex, Halen: 6}
	copy(sll.Addr[:], frame[0:6])
	if err := unix.Sendto(target.fd, frame, 0, sll); err != nil {
		log.Printf("write to port %d: %v", target.ID, err)
	}
}

// servePort registers an external agent as a virtual port (a host on the
// pigeon network with no veth). First message is JSON {name, mac, ip}; after
// that, binary messages are ingress ethernet frames, and the loft writes
// egress frames back over the same socket. This is the substrate for VPN
// gateways and the perch desktop agent — a real host, bridged in.
func (l *Loft) servePort(conn *websocket.Conn) {
	_, reg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return
	}
	var meta struct {
		Name string `json:"name"`
		MAC  string `json:"mac"`
		IP   string `json:"ip"`
	}
	if json.Unmarshal(reg, &meta) != nil || meta.Name == "" || meta.MAC == "" {
		conn.WriteMessage(websocket.TextMessage, []byte(`{"error":"first message must be {name,mac,ip}"}`))
		conn.Close()
		return
	}

	l.mu.Lock()
	id := l.nextID
	l.nextID++
	p := &Port{
		ID: id, Node: l.node, virtual: true, agent: conn, done: make(chan struct{}),
		PortMeta: PortMeta{
			Ifname: "agent-" + meta.Name, MAC: meta.MAC, IP: meta.IP,
			Pod: meta.Name, Namespace: "edge", ContainerID: "agent",
		},
	}
	l.ports["agent-"+meta.Name+"-"+itoa(id)] = p
	l.byID[id] = p
	l.mu.Unlock()

	log.Printf("agent port %d joined: %s ip=%s mac=%s", id, meta.Name, meta.IP, meta.MAC)
	l.notifyJSON(map[string]any{"type": "port-added", "port": p})
	conn.WriteMessage(websocket.TextMessage, []byte(`{"ok":true,"id":`+itoa(id)+`}`))

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.BinaryMessage {
			l.ingest(p, data)
		}
	}

	l.mu.Lock()
	for name, q := range l.ports {
		if q == p {
			delete(l.ports, name)
			break
		}
	}
	delete(l.byID, id)
	l.mu.Unlock()
	conn.Close()
	log.Printf("agent port %d (%s) left", id, meta.Name)
	l.notifyJSON(map[string]any{"type": "port-removed", "id": id})
}

func itoa(v uint16) string { return strconv.Itoa(int(v)) }

func (l *Loft) dropLocal(fid uint32) {
	l.mu.Lock()
	if f := l.frames[fid]; f != nil {
		delete(l.frames, fid)
		if !f.copied {
			if p := l.byID[f.port]; p != nil {
				p.dropsConsumer++
			}
		}
	}
	l.mu.Unlock()
}

// ---- consumers (router + observers) ------------------------------------------

func (l *Loft) attachConsumer(conn *websocket.Conn, observe bool) {
	l.mu.Lock()
	if observe {
		l.observers[conn] = &sync.Mutex{}
	} else {
		if l.client != nil {
			l.client.Close()
		}
		l.client = conn
	}
	hello := map[string]any{
		"type": "hello", "version": protocolVersion, "node": l.node,
		"role":  map[bool]string{true: "observer", false: "router"}[observe],
		"ports": l.allPortsLocked(),
	}
	l.mu.Unlock()

	role := "router"
	if observe {
		role = "observer"
	}
	log.Printf("%s connected from %s", role, conn.RemoteAddr())
	helloData, _ := json.Marshal(hello)
	l.sendTextTo(conn, observe, helloData)

	// A greeting log line, to this consumer only: guarantees onLog fires on the
	// live path (the loft is a frame plane — it narrates what it actually sees:
	// who it is, backpressure, peer health; not ARP/ping, which it can't read).
	nPorts := len(hello["ports"].([]any))
	greet, _ := json.Marshal(map[string]any{
		"type": "log", "who": "loft",
		"line": fmt.Sprintf("attached to node %q as %s — %d port(s) in view", l.node, role, nPorts),
	})
	l.sendTextTo(conn, observe, greet)

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			log.Printf("%s hung up: %v", role, err)
			l.mu.Lock()
			if observe {
				delete(l.observers, conn)
			} else if l.client == conn {
				l.client = nil
			}
			l.mu.Unlock()
			return
		}
		if observe || mt != websocket.BinaryMessage || len(data) < 7 {
			continue
		}
		l.consumerMsg(data[0], binary.BigEndian.Uint16(data[1:3]), binary.BigEndian.Uint32(data[3:7]))
	}
}

// allPortsLocked returns local + remote ports for hello; caller holds l.mu.
func (l *Loft) allPortsLocked() []any {
	out := []any{}
	for _, p := range l.ports {
		out = append(out, p)
	}
	for id, rp := range l.remotePorts {
		out = append(out, rp.consumerJSON(id))
	}
	return out
}

// consumerMsg routes a router verdict. Frames and ports may each be local or
// remote; payloads move loft-to-loft, never through here unless we own them.
func (l *Loft) consumerMsg(t byte, portID uint16, fid uint32) {
	switch t {
	case msgDeliver, msgCopyDeliver:
		consume := t == msgDeliver
		l.mu.Lock()
		rf, frameRemote := l.remoteFrames[fid]
		rp, portRemote := l.remotePorts[portID]
		l.mu.Unlock()

		switch {
		case !frameRemote && !portRemote:
			l.deliverLocal(portID, fid, consume)
		case !frameRemote && portRemote:
			// Our frame, their port: push the payload across the mesh.
			l.mu.Lock()
			f := l.frames[fid]
			var data []byte
			if f != nil {
				if consume {
					delete(l.frames, fid)
				} else {
					f.copied = true
				}
				data = f.data
				if ing := l.byID[f.port]; ing != nil {
					lat := uint64(time.Since(f.added).Microseconds())
					ing.latSumUs += lat
					ing.latCount++
					if lat > ing.latMaxUs {
						ing.latMaxUs = lat
					}
				}
			}
			addr, remoteID := rp.addr, rp.remoteID
			l.mu.Unlock()
			if data != nil {
				l.peerSend(addr, remoteID, data)
			}
		case frameRemote && portRemote && rf.edge == rp.edge:
			// Same edge owns both: forward the verdict, payload never moves
			// off that node.
			rf.edge.send7(t, rp.remoteID, rf.remoteFID)
			if consume {
				l.mu.Lock()
				delete(l.remoteFrames, fid)
				l.mu.Unlock()
			}
		case frameRemote:
			// Tell the ingress loft to push its payload to the egress loft.
			addr, remoteID := l.addr, portID // egress local to us (the gateway)
			if portRemote {
				addr, remoteID = rp.addr, rp.remoteID
			}
			flags := uint16(0)
			if consume {
				flags = 1
			}
			rf.edge.sendRemote(flags, rf.remoteFID, remoteID, addr)
			l.mu.Lock()
			if consume {
				delete(l.remoteFrames, fid)
			}
			l.mu.Unlock()
		}

	case msgDrop:
		l.mu.Lock()
		rf, frameRemote := l.remoteFrames[fid]
		if frameRemote {
			delete(l.remoteFrames, fid)
		}
		l.mu.Unlock()
		if frameRemote {
			rf.edge.send7(msgDrop, 0, rf.remoteFID)
		} else {
			l.dropLocal(fid)
		}
	}
}

// ---- mesh data plane (/peer) --------------------------------------------------

// servePeer accepts payload pushes from sibling lofts.
func (l *Loft) servePeer(conn *websocket.Conn) {
	defer conn.Close()
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.BinaryMessage || len(data) < 7 || data[0] != msgInject {
			continue
		}
		portID := binary.BigEndian.Uint16(data[1:3])
		frame := data[7:]
		if len(frame) < 14 {
			continue
		}
		l.mu.Lock()
		target := l.byID[portID]
		if target != nil {
			target.txFrames++
			target.txBytes += uint64(len(frame))
		}
		l.mu.Unlock()
		if target != nil {
			l.writeOut(target, frame)
		}
	}
}

// peerSend pushes a payload to another loft, dialing (and caching) the peer
// connection on demand. Failures are trunk drops — counted, never silent.
func (l *Loft) peerSend(addr string, portID uint16, frame []byte) {
	l.mu.Lock()
	pc := l.peers[addr]
	if pc == nil {
		pc = &peerConn{}
		l.peers[addr] = pc
	}
	l.mu.Unlock()

	pc.mu.Lock()
	defer pc.mu.Unlock()
	if pc.conn == nil {
		conn, _, err := websocket.DefaultDialer.Dial("ws://"+addr+"/peer", nil)
		if err != nil {
			l.mu.Lock()
			l.dropTrunk++
			l.mu.Unlock()
			log.Printf("peer %s unreachable: %v", addr, err)
			l.peerLogLocked(pc, fmt.Sprintf("peer %s unreachable — cross-node frames dropping (drops.trunk)", addr))
			return
		}
		pc.conn = conn
	}
	msg := make([]byte, 7+len(frame))
	msg[0] = msgInject
	binary.BigEndian.PutUint16(msg[1:3], portID)
	copy(msg[7:], frame)
	if err := pc.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
		pc.conn.Close()
		pc.conn = nil
		l.mu.Lock()
		l.dropTrunk++
		l.mu.Unlock()
		log.Printf("peer %s write failed: %v", addr, err)
		l.peerLogLocked(pc, fmt.Sprintf("peer %s write failed — cross-node frames dropping (drops.trunk)", addr))
	}
}

// peerLogLocked narrates a peer failure at most once per 5s per peer. Caller
// holds pc.mu (but NOT l.mu — notifyLog grabs l.mu itself).
func (l *Loft) peerLogLocked(pc *peerConn, line string) {
	if time.Since(pc.lastLog) < 5*time.Second {
		return
	}
	pc.lastLog = time.Now()
	l.notifyLog("loft", line)
}

// ---- housekeeping & stats -----------------------------------------------------

func (l *Loft) housekeeping() {
	tick := time.NewTicker(statsPeriod)
	for range tick.C {
		now := time.Now()
		l.mu.Lock()
		for fid, f := range l.frames {
			if now.Sub(f.added) > bufTTL {
				delete(l.frames, fid)
				if p := l.byID[f.port]; p != nil {
					p.dropsTTL++
				}
			}
		}
		for fid, rf := range l.remoteFrames {
			if now.Sub(rf.added) > bufTTL+5*time.Second {
				delete(l.remoteFrames, fid) // edge counted its own TTL drop
			}
		}
		stats := l.statsLocked()
		portsOnly := stats["ports"]
		l.mu.Unlock()

		data, _ := json.Marshal(stats)
		l.sendTextToRouter(data)
		l.broadcastObserversText(data)
		if l.trunk != nil {
			l.trunk.sendJSON(map[string]any{"type": "trunk-stats", "node": l.node, "ports": portsOnly})
		}
	}
}

// statsLocked builds the stats message (local ports + edge-reported); caller
// holds l.mu.
func (l *Loft) statsLocked() map[string]any {
	perPort := map[string]any{}
	for _, p := range l.ports {
		perPort[p.Pod] = map[string]any{
			"node":     p.Node,
			"rxFrames": p.rxFrames, "rxBytes": p.rxBytes,
			"txFrames": p.txFrames, "txBytes": p.txBytes,
			"drops": map[string]uint64{
				"overflow": p.dropsOverflow, "ttl": p.dropsTTL,
				"consumer": p.dropsConsumer, "trunk": p.dropsTrunk,
			},
			"deliverLatencyUs": map[string]uint64{
				"sum": p.latSumUs, "count": p.latCount, "max": p.latMaxUs,
			},
		}
	}
	for _, edgePorts := range l.edgeStats {
		for pod, s := range edgePorts {
			perPort[pod] = s
		}
	}
	return map[string]any{
		"type": "stats", "node": l.node, "buffered": len(l.frames),
		"droppedNoConsumer": l.noGame, "droppedTrunk": l.dropTrunk,
		"edges": len(l.edges), "ports": perPort,
	}
}

// ---- consumer send helpers ------------------------------------------------------

func (l *Loft) sendToRouter(data []byte) bool {
	l.mu.Lock()
	c := l.client
	l.mu.Unlock()
	if c == nil {
		return false
	}
	l.cwmu.Lock()
	defer l.cwmu.Unlock()
	return c.WriteMessage(websocket.BinaryMessage, data) == nil
}

func (l *Loft) sendTextToRouter(data []byte) {
	l.mu.Lock()
	c := l.client
	l.mu.Unlock()
	if c == nil {
		return
	}
	l.cwmu.Lock()
	c.WriteMessage(websocket.TextMessage, data)
	l.cwmu.Unlock()
}

// notifyJSON sends a control message to router + observers.
func (l *Loft) notifyJSON(v any) {
	data, _ := json.Marshal(v)
	l.sendTextToRouter(data)
	l.broadcastObserversText(data)
}

// notifyLog narrates an operational event to the consumer (onLog). Reserved for
// things the loft genuinely observes and that aren't already a typed control
// message — keep it low-frequency (see the overflow edge-trigger, peer rate
// limit). MUST be called without l.mu held.
func (l *Loft) notifyLog(who, line string) {
	l.notifyJSON(map[string]any{"type": "log", "who": who, "line": line})
}

// sendTextTo writes one text frame to a single consumer, taking the right lock
// for its role (the exclusive router vs. a specific observer).
func (l *Loft) sendTextTo(conn *websocket.Conn, observe bool, data []byte) {
	if observe {
		l.mu.Lock()
		mu := l.observers[conn]
		l.mu.Unlock()
		if mu != nil {
			mu.Lock()
			conn.WriteMessage(websocket.TextMessage, data)
			mu.Unlock()
		}
	} else {
		l.cwmu.Lock()
		conn.WriteMessage(websocket.TextMessage, data)
		l.cwmu.Unlock()
	}
}

func (l *Loft) broadcastObservers(data []byte) {
	l.eachObserver(func(c *websocket.Conn, mu *sync.Mutex) {
		mu.Lock()
		c.WriteMessage(websocket.BinaryMessage, data)
		mu.Unlock()
	})
}

func (l *Loft) broadcastObserversText(data []byte) {
	l.eachObserver(func(c *websocket.Conn, mu *sync.Mutex) {
		mu.Lock()
		c.WriteMessage(websocket.TextMessage, data)
		mu.Unlock()
	})
}

func (l *Loft) eachObserver(fn func(*websocket.Conn, *sync.Mutex)) {
	l.mu.Lock()
	conns := make(map[*websocket.Conn]*sync.Mutex, len(l.observers))
	for c, mu := range l.observers {
		conns[c] = mu
	}
	l.mu.Unlock()
	for c, mu := range conns {
		fn(c, mu)
	}
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }
