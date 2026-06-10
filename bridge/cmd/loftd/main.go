// loftd — the pigeon loft daemon.
//
// loftd is the data plane of Pigeon ISP. The pigeon-cni plugin wires each
// aviary pod up with a veth pair whose host end is attached to NOTHING — no
// bridge, no routes, no kernel forwarding. The only way a frame moves between
// pods is if the game physically carries its pigeon to a dovecote.
//
// Performance architecture: FULL FRAMES NEVER CROSS THE WEBSOCKET. The game
// would melt under a multi-gig UDP stream if it did. Instead:
//
//	frame arrives  -> loftd buffers the payload node-side, assigns a frameId,
//	                  sends the game a TOKEN: (port, id, length, ~128B header
//	                  snapshot for the inspector)
//	game routes it -> game sends back (deliver, egressPort, id); loftd writes
//	                  the buffered frame onto that veth
//	game drops it  -> explicit drop message, or TTL/queue-overflow eviction
//	                  in loftd. Tail drop with counters — like a real router
//	                  queue, because it is one.
//
// Later milestones add flow offload: the game installs match->egress rules so
// established flows stop visiting the factory (slow path/fast path, exactly
// like CPU vs ASIC in real routers). Message types are reserved below.
//
// Wire protocol (ws://host:9777/ws):
//
//	Text: JSON control
//	  {"type":"hello","ports":[Port...]}              loftd -> game
//	  {"type":"port-added","port":Port}               loftd -> game
//	  {"type":"port-removed","id":N}                  loftd -> game
//	  {"type":"stats","ports":{...},"buffered":N}     loftd -> game, 1/sec
//	Binary, big-endian:
//	  0x01 token    loftd -> game  [1][u16 port][u32 frameId][u32 fullLen][snapshot...]
//	  0x02 deliver  game -> loftd  [1][u16 egressPort][u32 frameId]
//	  0x03 drop     game -> loftd  [1][u16 0][u32 frameId]
//	  0x10/0x11 offload-add/remove: reserved for the fast path.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
	msgCopyDeliver = 0x04 // deliver WITHOUT consuming — flooding/broadcast

	maxFrame    = 9216
	snapshotLen = 128              // header bytes shipped to the game
	bufTTL      = 30 * time.Second // undelivered pigeons expire
	maxBuffered = 8192             // total frames held across all ports
	statsPeriod = time.Second
)

// PortMeta is written by pigeon-cni to <portsDir>/<ifname>.json on ADD and
// removed on DEL.
type PortMeta struct {
	Ifname      string `json:"ifname"`
	MAC         string `json:"mac"`
	IP          string `json:"ip"`
	Pod         string `json:"pod"`
	Namespace   string `json:"namespace"`
	ContainerID string `json:"containerId"`
}

type Port struct {
	ID uint16 `json:"id"`
	PortMeta
	fd      int
	ifindex int
	done    chan struct{}

	rxFrames, rxBytes, txFrames, txBytes uint64
	// The no-silent-drop rule (docs/pigeon-api.md): every lost frame lands in
	// exactly one of these.
	dropsOverflow, dropsTTL, dropsConsumer uint64
	// Decision latency: arrival -> deliver, microseconds. This is the "pigeon
	// network overhead" half of the telemetry split; the consumer reports its
	// own handling time separately (docs/benchmarks.md).
	latSumUs, latCount, latMaxUs uint64
}

type bufFrame struct {
	port   uint16
	data   []byte
	added  time.Time
	copied bool // copy-delivered at least once; freeing it isn't a loss
}

type Loft struct {
	mu      sync.Mutex
	ports   map[string]*Port
	nextID  uint16
	frames  map[uint32]*bufFrame
	nextFID uint32
	client  *websocket.Conn
	wmu     sync.Mutex
	noGame  uint64 // frames dropped because no game was connected
}

func main() {
	listen := flag.String("listen", ":9777", "websocket listen address")
	portsDir := flag.String("ports-dir", "/run/pigeon/ports", "directory pigeon-cni writes port metadata into")
	flag.Parse()

	loft := &Loft{ports: map[string]*Port{}, nextID: 1, frames: map[uint32]*bufFrame{}, nextFID: 1}

	if err := os.MkdirAll(*portsDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", *portsDir, err)
	}
	go loft.scanLoop(*portsDir)
	go loft.housekeeping()

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}
		loft.attachGame(conn)
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		loft.mu.Lock()
		n, b, d := len(loft.ports), len(loft.frames), loft.noGame
		loft.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"loft": "open", "ports": n, "buffered": b, "droppedNoConsumer": d})
	})
	// Full telemetry snapshot for benchmark scripts (same shape as the 1 Hz
	// ws stats message).
	http.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		loft.mu.Lock()
		stats := loft.statsLocked()
		loft.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	})

	log.Printf("loftd: the loft is open on %s, watching %s", *listen, *portsDir)
	log.Fatal(http.ListenAndServe(*listen, nil))
}

// ---- port lifecycle ---------------------------------------------------------

// scanLoop polls the ports directory; pigeon-cni's metadata files are the
// source of truth for which veths belong to the loft.
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
			if !seen[name] {
				gone = append(gone, p)
				delete(l.ports, name)
			}
		}
		l.mu.Unlock()
		for _, p := range gone {
			close(p.done)
			unix.Close(p.fd)
			log.Printf("port %d (%s, pod %s) flew away", p.ID, p.Ifname, p.Pod)
			l.sendJSON(map[string]any{"type": "port-removed", "id": p.ID})
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

	// SOCK_RAW packet socket bound to this veth: every frame the pod sends,
	// headers and all. ETH_P_ALL in network byte order.
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW|unix.SOCK_CLOEXEC, int(htons(unix.ETH_P_ALL)))
	if err != nil {
		return err
	}
	sll := &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_ALL), Ifindex: iface.Index}
	if err := unix.Bind(fd, sll); err != nil {
		unix.Close(fd)
		return err
	}
	// Promiscuous, so dst-MAC filtering can't hide anything from the loft.
	mreq := &unix.PacketMreq{Ifindex: int32(iface.Index), Type: unix.PACKET_MR_PROMISC}
	if err := unix.SetsockoptPacketMreq(fd, unix.SOL_PACKET, unix.PACKET_ADD_MEMBERSHIP, mreq); err != nil {
		log.Printf("promisc on %s: %v (continuing)", ifname, err)
	}

	l.mu.Lock()
	id := l.nextID
	l.nextID++
	p := &Port{ID: id, PortMeta: meta, fd: fd, ifindex: iface.Index, done: make(chan struct{})}
	l.ports[ifname] = p
	l.mu.Unlock()

	log.Printf("port %d roosted: %s pod=%s/%s ip=%s mac=%s", id, ifname, meta.Namespace, meta.Pod, meta.IP, meta.MAC)
	l.sendJSON(map[string]any{"type": "port-added", "port": p})
	go l.readLoop(p)
	return nil
}

// ---- frame path -------------------------------------------------------------

// readLoop pulls frames off one pod's veth, buffers them, and releases a
// token-pigeon into the game.
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
		// Frames we injected with sendto() echo back flagged as outgoing —
		// those are pigeons landing, not taking off.
		if sll, ok := from.(*unix.SockaddrLinklayer); ok && sll.Pkttype == unix.PACKET_OUTGOING {
			continue
		}
		if n < 14 {
			continue
		}

		l.mu.Lock()
		p.rxFrames++
		p.rxBytes += uint64(n)
		if l.client == nil {
			l.noGame++
			l.mu.Unlock()
			continue // the router doesn't exist; the frame never happened
		}
		if len(l.frames) >= maxBuffered {
			p.dropsOverflow++ // queue full: tail drop, like the real thing
			l.mu.Unlock()
			continue
		}
		fid := l.nextFID
		l.nextFID++
		data := make([]byte, n)
		copy(data, buf[:n])
		l.frames[fid] = &bufFrame{port: p.ID, data: data, added: time.Now()}
		l.mu.Unlock()

		snap := n
		if snap > snapshotLen {
			snap = snapshotLen
		}
		msg := make([]byte, 11+snap)
		msg[0] = msgToken
		binary.BigEndian.PutUint16(msg[1:3], p.ID)
		binary.BigEndian.PutUint32(msg[3:7], fid)
		binary.BigEndian.PutUint32(msg[7:11], uint32(n))
		copy(msg[11:], data[:snap])
		l.sendBinary(msg)
	}
}

// deliver writes a buffered frame to a port's veth — the pigeon lands and the
// pod's kernel receives a real ethernet frame. Wrong dovecote? The kernel
// drops mismatched dst MACs; the game doesn't need to be right, physics
// grades it.
func (l *Loft) deliver(portID uint16, fid uint32, consume bool) {
	l.mu.Lock()
	f := l.frames[fid]
	if consume {
		delete(l.frames, fid)
	}
	var target *Port
	for _, p := range l.ports {
		if p.ID == portID {
			target = p
			break
		}
	}
	if f != nil && target != nil {
		if !consume {
			f.copied = true
		}
		target.txFrames++
		target.txBytes += uint64(len(f.data))
		lat := uint64(time.Since(f.added).Microseconds())
		target.latSumUs += lat
		target.latCount++
		if lat > target.latMaxUs {
			target.latMaxUs = lat
		}
	}
	l.mu.Unlock()
	if f == nil || target == nil {
		return
	}
	sll := &unix.SockaddrLinklayer{Ifindex: target.ifindex, Halen: 6}
	copy(sll.Addr[:], f.data[0:6])
	if err := unix.Sendto(target.fd, f.data, 0, sll); err != nil {
		log.Printf("deliver frame %d to port %d: %v", fid, portID, err)
	}
}

// housekeeping expires undelivered pigeons and publishes stats.
func (l *Loft) housekeeping() {
	tick := time.NewTicker(statsPeriod)
	for range tick.C {
		now := time.Now()
		l.mu.Lock()
		for fid, f := range l.frames {
			if now.Sub(f.added) > bufTTL {
				delete(l.frames, fid)
				for _, p := range l.ports {
					if p.ID == f.port {
						p.dropsTTL++
						break
					}
				}
			}
		}
		stats := l.statsLocked()
		l.mu.Unlock()
		l.sendJSON(stats)
	}
}

// statsLocked builds the stats message; caller holds l.mu.
func (l *Loft) statsLocked() map[string]any {
	perPort := map[string]any{}
	for _, p := range l.ports {
		perPort[p.Pod] = map[string]any{
			"rxFrames": p.rxFrames, "rxBytes": p.rxBytes,
			"txFrames": p.txFrames, "txBytes": p.txBytes,
			"drops": map[string]uint64{
				"overflow": p.dropsOverflow, "ttl": p.dropsTTL, "consumer": p.dropsConsumer,
			},
			"deliverLatencyUs": map[string]uint64{
				"sum": p.latSumUs, "count": p.latCount, "max": p.latMaxUs,
			},
		}
	}
	return map[string]any{
		"type": "stats", "buffered": len(l.frames),
		"droppedNoConsumer": l.noGame, "ports": perPort,
	}
}

// ---- game session -----------------------------------------------------------

// attachGame makes conn the active game client. One loft floor, one player —
// the previous connection is hung up on.
func (l *Loft) attachGame(conn *websocket.Conn) {
	l.mu.Lock()
	if l.client != nil {
		l.client.Close()
	}
	l.client = conn
	ports := make([]*Port, 0, len(l.ports))
	for _, p := range l.ports {
		ports = append(ports, p)
	}
	l.mu.Unlock()

	log.Printf("game connected from %s", conn.RemoteAddr())
	l.sendJSON(map[string]any{"type": "hello", "ports": ports})

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			log.Printf("game hung up: %v", err)
			l.mu.Lock()
			if l.client == conn {
				l.client = nil
			}
			l.mu.Unlock()
			return
		}
		if mt != websocket.BinaryMessage || len(data) < 7 {
			continue
		}
		portID := binary.BigEndian.Uint16(data[1:3])
		fid := binary.BigEndian.Uint32(data[3:7])
		switch data[0] {
		case msgDeliver:
			l.deliver(portID, fid, true)
		case msgCopyDeliver:
			// Flooding: copies go out per-port; the consumer frees the frame
			// with an explicit drop (or TTL does). Still no silent path.
			l.deliver(portID, fid, false)
		case msgDrop:
			l.mu.Lock()
			if f := l.frames[fid]; f != nil {
				delete(l.frames, fid)
				if !f.copied { // freeing a flooded frame isn't a loss
					for _, p := range l.ports {
						if p.ID == f.port {
							p.dropsConsumer++
							break
						}
					}
				}
			}
			l.mu.Unlock()
		}
	}
}

func (l *Loft) sendJSON(v any) {
	data, _ := json.Marshal(v)
	l.wmu.Lock()
	defer l.wmu.Unlock()
	l.mu.Lock()
	c := l.client
	l.mu.Unlock()
	if c != nil {
		c.WriteMessage(websocket.TextMessage, data)
	}
}

func (l *Loft) sendBinary(data []byte) bool {
	l.wmu.Lock()
	defer l.wmu.Unlock()
	l.mu.Lock()
	c := l.client
	l.mu.Unlock()
	if c == nil {
		return false
	}
	return c.WriteMessage(websocket.BinaryMessage, data) == nil
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }
