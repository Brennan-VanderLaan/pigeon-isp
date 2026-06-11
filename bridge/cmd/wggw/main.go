// wg-gateway — terminate WireGuard from real desktops and bridge each peer,
// PER PEER, onto the pigeon network as its own virtual host.
//
// A desktop runs the stock WireGuard client (no custom software). It connects
// over UDP; userspace WireGuard (wireguard-go, no kernel module) decrypts its
// IP packets. The gateway then does L3<->L2 per peer: each peer gets its own
// MAC/IP and a virtual port on the loft (/port API), with a little ARP
// responder/requester — so on the factory floor every desktop is a distinct
// host you can watch and route, not one shared NAT blob.
//
//	peer pkt --wg decrypt--> demux by src IP --> bridgeHost --eth--> loft
//	loft frame --> bridgeHost strips eth / answers ARP --> wg encrypt --> peer
//
// Keys: for a frictionless lab demo the gateway MINTS N peer slots (keypair +
// aviary IP each) and serves ready-to-paste client configs on :8088/configs.
// Grab one, import into WireGuard, connect. (A lab convenience — the gateway
// holds the peers' private keys; real deployments would have peers submit
// their public keys instead.)
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	qrcode "github.com/skip2/go-qrcode"
	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

func main() {
	gateway := flag.String("gateway", "10.5.0.2:9777", "loft gateway host:port")
	wgPort := flag.Int("wg-port", 51820, "WireGuard UDP listen port")
	endpoint := flag.String("endpoint", "127.0.0.1:51820", "endpoint desktops dial (host:port)")
	peers := flag.Int("peers", 4, "number of peer slots to mint")
	baseIP := flag.String("base-ip", "10.99.0.200", "first peer's aviary IP")
	httpAddr := flag.String("http", ":8088", "config server listen address")
	dns := flag.String("dns", "10.99.0.1", "DNS server pushed to clients (the uplink resolver)")
	domain := flag.String("domain", "pigeon.isp", "search domain pushed to clients")
	flag.Parse()

	// Keys: derive from a stable seed (WG_SEED) when present, so the gateway
	// keeps the SAME keys across pod restarts/redeploys and already-scanned
	// QRs/configs stay valid. Without a seed, fall back to random (a single
	// run is fine; a restart then invalidates clients — the lab footgun this
	// avoids). up.ps1 plants a per-cluster random seed in a Secret.
	seed := seedFromEnv()
	gwPriv, gwPub := deriveKey(seed, "gw")
	base := net.ParseIP(*baseIP).To4()
	if base == nil {
		log.Fatalf("bad base ip %s", *baseIP)
	}

	g := &gw{loftURL: "ws://" + *gateway + "/port", endpoint: *endpoint, gwPub: gwPub, dns: *dns, domain: *domain}
	tdev := newChanTun(1420, g.fromPeer)
	g.tun = tdev

	logger := device.NewLogger(device.LogLevelError, "wg ")
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), logger)
	g.dev = dev // so /configs can report real handshake / byte counters

	uapi := fmt.Sprintf("private_key=%s\nlisten_port=%d\n", hex.EncodeToString(gwPriv), *wgPort)

	// Mint peers: one keypair + IP each, registered with WireGuard and bridged.
	for i := 0; i < *peers; i++ {
		pPriv, pPub := deriveKey(seed, fmt.Sprintf("peer:%d", i))
		ip := make(net.IP, 4)
		copy(ip, base)
		ip[3] = base[3] + byte(i)
		mac := macForIP(ip)
		uapi += fmt.Sprintf("public_key=%s\nallowed_ip=%s/32\n", hex.EncodeToString(pPub), ip.String())
		g.addPeer(&peer{
			index: i, ip: ip, mac: mac,
			privB64: base64.StdEncoding.EncodeToString(pPriv),
			pubB64:  base64.StdEncoding.EncodeToString(pPub),
			pubHex:  hex.EncodeToString(pPub), // key for wireguard's IpcGet status
		})
	}

	if err := dev.IpcSet(uapi); err != nil {
		log.Fatalf("wg config: %v", err)
	}
	if err := dev.Up(); err != nil {
		log.Fatalf("wg up: %v", err)
	}
	log.Printf("wg-gateway up: %d peer slots, wg pubkey %s, udp :%d", *peers, base64.StdEncoding.EncodeToString(gwPub), *wgPort)

	// Each bridgeHost dials the loft and bridges its peer.
	for _, p := range g.peers {
		go p.host.run()
	}

	http.HandleFunc("/configs", g.serveConfigs)
	http.HandleFunc("/vpn/configs", g.serveConfigs) // behind the traefik /vpn prefix
	// A phone scans the QR straight into the WireGuard app — no typing, no file
	// copy. The QR encodes the exact same config text /configs serves.
	http.HandleFunc("/qr/", g.serveQR)
	http.HandleFunc("/vpn/qr/", g.serveQR)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "wg-gateway\n") })
	log.Fatal(http.ListenAndServe(*httpAddr, nil))
}

// ---- gateway ----------------------------------------------------------------

type gw struct {
	loftURL  string
	endpoint string
	gwPub    []byte
	dns      string // resolver pushed to clients (uplink)
	domain   string // search domain pushed to clients
	tun      *chanTun
	dev      *device.Device
	mu       sync.Mutex
	peers    []*peer
	byIP     map[string]*bridgeHost
}

type peer struct {
	index           int
	ip              net.IP
	mac             net.HardwareAddr
	privB64, pubB64 string
	pubHex          string
	host            *bridgeHost
}

func (g *gw) addPeer(p *peer) {
	if g.byIP == nil {
		g.byIP = map[string]*bridgeHost{}
	}
	h := &bridgeHost{gw: g, ip: p.ip, mac: p.mac, name: fmt.Sprintf("vpn%d", p.index), arp: map[string]net.HardwareAddr{}}
	p.host = h
	g.peers = append(g.peers, p)
	g.byIP[p.ip.String()] = h
}

// fromPeer is called by the tun with a decrypted IP packet (peer -> aviary).
// Demux by source IP to the owning bridgeHost.
func (g *gw) fromPeer(ippkt []byte) {
	if len(ippkt) < 20 || ippkt[0]>>4 != 4 {
		return
	}
	src := net.IP(ippkt[12:16]).String()
	g.mu.Lock()
	h := g.byIP[src]
	g.mu.Unlock()
	if h != nil {
		h.sendIP(ippkt)
	}
}

// toPeer hands an IP packet (aviary -> peer) to WireGuard, which routes it to
// the right peer by destination IP.
func (g *gw) toPeer(ippkt []byte) {
	g.tun.deliver(ippkt)
}

// configFor renders the WireGuard client config for a peer at `endpoint`. Same
// text whether it's copy-pasted (/configs) or encoded into a QR (/qr).
//
// full tunnel  -> AllowedIPs 0.0.0.0/0 : ALL the device's traffic (YouTube, apps,
//                 DNS) rides the tunnel and must be routed to the uplink or it
//                 doesn't load — the pigeons carry your real internet.
// split tunnel -> AllowedIPs 10.99.0.0/16 : only pigeon hosts go through; the
//                 device uses its normal internet for everything else.
func (g *gw) configFor(p *peer, endpoint string, full bool) string {
	allowed := "10.99.0.0/16"
	if full {
		allowed = "0.0.0.0/0, ::/0"
	}
	iface := fmt.Sprintf("[Interface]\nPrivateKey = %s\nAddress = %s/16\n", p.privB64, p.ip.String())
	if g.dns != "" {
		// wg-quick reads non-IP entries on the DNS line as the search domain.
		iface += fmt.Sprintf("DNS = %s, %s\n", g.dns, g.domain)
	}
	return iface + fmt.Sprintf(
		"\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = %s\nPersistentKeepalive = 15\n",
		base64.StdEncoding.EncodeToString(g.gwPub), endpoint, allowed)
}

// fullTunnel decides split vs full from the request (default full — the demo).
func fullTunnel(r *http.Request) bool {
	return r.URL.Query().Get("mode") != "split"
}

// resolveEndpoint swaps in a caller-supplied gateway host (e.g. the LAN IP a
// phone can actually reach) while keeping the configured WireGuard UDP port.
// 127.0.0.1 is useless to a phone, so the UI passes ?host=<your LAN ip>.
func (g *gw) resolveEndpoint(host string) string {
	host = sanitizeHost(host)
	if host == "" {
		return g.endpoint
	}
	port := "51820"
	if _, p, err := net.SplitHostPort(g.endpoint); err == nil && p != "" {
		port = p
	}
	return net.JoinHostPort(host, port)
}

// sanitizeHost keeps only characters legal in a hostname / IP literal, so a
// query param can never inject extra lines into the rendered config.
func sanitizeHost(h string) string {
	h = strings.TrimSpace(h)
	for _, r := range h {
		ok := r == '.' || r == '-' || r == ':' || r == '%' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !ok {
			return ""
		}
	}
	if len(h) > 253 {
		return ""
	}
	return h
}

// wgStat is one peer's live WireGuard state, read from wireguard-go's UAPI.
type wgStat struct {
	handshakeSec int64  // unix secs of last handshake, 0 = never
	rx, tx       uint64 // bytes
	endpoint     string // the device's current source addr (its public ip:port)
}

// wgStatus queries the userspace WireGuard device for per-peer telemetry. This
// is the ground truth for "is the tunnel actually up" — a real handshake only
// happens when a device with the matching key connects.
func (g *gw) wgStatus() map[string]wgStat {
	res := map[string]wgStat{}
	if g.dev == nil {
		return res
	}
	dump, err := g.dev.IpcGet()
	if err != nil {
		return res
	}
	var cur string
	var st wgStat
	flush := func() {
		if cur != "" {
			res[cur] = st
		}
	}
	for _, line := range strings.Split(dump, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "public_key":
			flush()
			cur, st = v, wgStat{}
		case "last_handshake_time_sec":
			st.handshakeSec, _ = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			st.rx, _ = strconv.ParseUint(v, 10, 64)
		case "tx_bytes":
			st.tx, _ = strconv.ParseUint(v, 10, 64)
		case "endpoint":
			st.endpoint = v
		}
	}
	flush()
	return res
}

func (g *gw) serveConfigs(w http.ResponseWriter, r *http.Request) {
	ep := g.resolveEndpoint(r.URL.Query().Get("host"))
	full := fullTunnel(r)
	// Carry host+mode onto the QR link so the scanned config matches what's
	// shown.
	qvals := url.Values{}
	if h := sanitizeHost(r.URL.Query().Get("host")); h != "" {
		qvals.Set("host", h)
	}
	if !full {
		qvals.Set("mode", "split")
	}
	q := ""
	if len(qvals) > 0 {
		q = "?" + qvals.Encode()
	}
	stats := g.wgStatus()
	now := time.Now().Unix()
	g.mu.Lock()
	defer g.mu.Unlock()
	out := []map[string]string{}
	for _, p := range g.peers {
		st := stats[p.pubHex]
		hs := "never"
		if st.handshakeSec > 0 {
			hs = fmt.Sprint(now - st.handshakeSec) // seconds since last handshake
		}
		out = append(out, map[string]string{
			"name": p.host.name, "ip": p.ip.String(), "config": g.configFor(p, ep, full),
			"connected": fmt.Sprint(p.host.connected()),
			"qr":        "/vpn/qr/" + p.host.name + ".png" + q,
			"handshake": hs,
			"rx":        fmt.Sprint(st.rx),
			"tx":        fmt.Sprint(st.tx),
			"wgPeer":    st.endpoint,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"peers": out, "endpoint": ep, "domain": g.domain,
		"mode": map[bool]string{true: "full", false: "split"}[full],
	})
}

// serveQR returns a PNG QR code of a peer's WireGuard config, ready to scan
// with the WireGuard mobile app. URL: /vpn/qr/<name>(.png), e.g. /vpn/qr/vpn0.
func (g *gw) serveQR(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Path
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSuffix(name, ".png")

	g.mu.Lock()
	var match *peer
	for _, p := range g.peers {
		if p.host.name == name {
			match = p
			break
		}
	}
	cfg := ""
	if match != nil {
		cfg = g.configFor(match, g.resolveEndpoint(r.URL.Query().Get("host")), fullTunnel(r))
	}
	g.mu.Unlock()

	if match == nil {
		http.Error(w, "no such peer", http.StatusNotFound)
		return
	}
	png, err := qrcode.Encode(cfg, qrcode.Medium, 512)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store") // config keys can rotate on restart
	w.Write(png)
}

// ---- per-peer bridge host ----------------------------------------------------

type bridgeHost struct {
	gw   *gw
	name string
	ip   net.IP
	mac  net.HardwareAddr

	mu   sync.Mutex
	conn *websocket.Conn
	arp  map[string]net.HardwareAddr // ip -> mac, learned from replies
	up   bool
}

func (h *bridgeHost) connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.up
}

func (h *bridgeHost) run() {
	for {
		c, _, err := websocket.DefaultDialer.Dial(h.gw.loftURL, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		reg := fmt.Sprintf(`{"name":"%s","mac":"%s","ip":"%s"}`, h.name, h.mac.String(), h.ip.String())
		c.WriteMessage(websocket.TextMessage, []byte(reg))
		h.mu.Lock()
		h.conn = c
		h.up = true
		h.mu.Unlock()
		log.Printf("%s bridged: %s (%s)", h.name, h.ip, h.mac)

		for {
			mt, data, err := c.ReadMessage()
			if err != nil {
				break
			}
			if mt == websocket.BinaryMessage {
				h.fromAviary(data)
			}
		}
		h.mu.Lock()
		h.up = false
		h.conn = nil
		h.mu.Unlock()
		time.Sleep(2 * time.Second)
	}
}

func (h *bridgeHost) sendFrame(frame []byte) {
	h.mu.Lock()
	c := h.conn
	h.mu.Unlock()
	if c != nil {
		h.mu.Lock()
		c.WriteMessage(websocket.BinaryMessage, frame)
		h.mu.Unlock()
	}
}

// sendIP wraps a peer's IP packet in ethernet and puts it on the aviary,
// resolving the destination MAC by ARP (who-has, cached).
func (h *bridgeHost) sendIP(ippkt []byte) {
	dst := net.IP(ippkt[16:20])
	h.mu.Lock()
	dmac, known := h.arp[dst.String()]
	h.mu.Unlock()
	if !known {
		h.arpRequest(dst) // ask; the packet is dropped (TCP/ping will retry)
		return
	}
	frame := make([]byte, 14+len(ippkt))
	copy(frame[0:6], dmac)
	copy(frame[6:12], h.mac)
	binary.BigEndian.PutUint16(frame[12:14], 0x0800)
	copy(frame[14:], ippkt)
	h.sendFrame(frame)
}

// fromAviary handles a frame the game routed to this host: answer ARP for our
// IP, learn ARP replies, and hand IP packets up to WireGuard for our peer.
func (h *bridgeHost) fromAviary(b []byte) {
	if len(b) < 14 {
		return
	}
	switch binary.BigEndian.Uint16(b[12:14]) {
	case 0x0806:
		h.onARP(b)
	case 0x0800:
		if len(b) >= 34 {
			dst := net.IP(b[30:34])
			if dst.Equal(h.ip) {
				h.gw.toPeer(b[14:]) // strip ethernet, give wg the IP packet
			}
		}
	}
}

func (h *bridgeHost) onARP(b []byte) {
	if len(b) < 42 {
		return
	}
	oper := binary.BigEndian.Uint16(b[20:22])
	sha := net.HardwareAddr(append([]byte(nil), b[22:28]...))
	spa := net.IP(append([]byte(nil), b[28:32]...))
	tpa := net.IP(b[38:42])
	if oper == 2 || (oper == 1 && len(spa) == 4) {
		h.mu.Lock()
		h.arp[spa.String()] = sha // learn sender either way
		h.mu.Unlock()
	}
	if oper == 1 && tpa.Equal(h.ip) {
		reply := make([]byte, 42)
		copy(reply[0:6], sha)
		copy(reply[6:12], h.mac)
		binary.BigEndian.PutUint16(reply[12:14], 0x0806)
		copy(reply[14:], []byte{0, 1, 8, 0, 6, 4, 0, 2})
		copy(reply[22:28], h.mac)
		copy(reply[28:32], h.ip)
		copy(reply[32:38], sha)
		copy(reply[38:42], spa)
		h.sendFrame(reply)
	}
}

func (h *bridgeHost) arpRequest(target net.IP) {
	req := make([]byte, 42)
	for i := 0; i < 6; i++ {
		req[i] = 0xff // broadcast
	}
	copy(req[6:12], h.mac)
	binary.BigEndian.PutUint16(req[12:14], 0x0806)
	copy(req[14:], []byte{0, 1, 8, 0, 6, 4, 0, 1})
	copy(req[22:28], h.mac)
	copy(req[28:32], h.ip)
	// tha zero
	copy(req[38:42], target.To4())
	h.sendFrame(req)
}

// ---- channel-backed tun (no kernel device) ----------------------------------

type chanTun struct {
	mtu    int
	toPeer chan []byte  // gw -> peers (wireguard Reads these)
	onPkt  func([]byte) // peers -> gw (wireguard Writes call this)
	events chan tun.Event
	closed chan struct{}
}

func newChanTun(mtu int, onPkt func([]byte)) *chanTun {
	t := &chanTun{
		mtu: mtu, onPkt: onPkt,
		toPeer: make(chan []byte, 256),
		events: make(chan tun.Event, 4),
		closed: make(chan struct{}),
	}
	t.events <- tun.EventUp
	return t
}

func (t *chanTun) deliver(ippkt []byte) {
	cp := make([]byte, len(ippkt))
	copy(cp, ippkt)
	select {
	case t.toPeer <- cp:
	default: // queue full: drop, upper layers retransmit
	}
}

func (t *chanTun) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	select {
	case pkt := <-t.toPeer:
		n := copy(bufs[0][offset:], pkt)
		sizes[0] = n
		return 1, nil
	case <-t.closed:
		return 0, os.ErrClosed
	}
}

func (t *chanTun) Write(bufs [][]byte, offset int) (int, error) {
	for _, b := range bufs {
		if len(b) <= offset {
			continue
		}
		pkt := make([]byte, len(b)-offset)
		copy(pkt, b[offset:])
		t.onPkt(pkt)
	}
	return len(bufs), nil
}

func (t *chanTun) Events() <-chan tun.Event { return t.events }
func (t *chanTun) MTU() (int, error)        { return t.mtu, nil }
func (t *chanTun) Name() (string, error)    { return "pigeon0", nil }
func (t *chanTun) BatchSize() int           { return 1 }
func (t *chanTun) File() *os.File           { return nil }
func (t *chanTun) Close() error {
	select {
	case <-t.closed:
	default:
		close(t.closed)
	}
	return nil
}

// ---- crypto helpers ---------------------------------------------------------

func genKey() (priv, pub []byte) {
	priv = make([]byte, 32)
	rand.Read(priv)
	return clampPub(priv)
}

// clampPub clamps a 32-byte scalar into a valid X25519 private key and returns
// it with its public key.
func clampPub(priv []byte) (p, pub []byte) {
	priv[0] &= 248
	priv[31] &= 127
	priv[31] |= 64
	pub, _ = curve25519.X25519(priv, curve25519.Basepoint)
	return priv, pub
}

// seedFromEnv reads WG_SEED (base64 or raw). Empty/short => nil, meaning "use
// random keys this run".
func seedFromEnv() []byte {
	s := strings.TrimSpace(os.Getenv("WG_SEED"))
	if s == "" {
		return nil
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil && len(b) >= 16 {
		return b
	}
	if len(s) >= 16 {
		return []byte(s)
	}
	return nil
}

// deriveKey deterministically derives a WireGuard keypair from (seed, label).
// Same seed+label => same keys, so configs survive restarts. With no seed it
// falls back to a fresh random key (previous behaviour).
func deriveKey(seed []byte, label string) (priv, pub []byte) {
	if seed == nil {
		return genKey()
	}
	h := sha256.Sum256(append(append([]byte(label), ':'), seed...))
	return clampPub(h[:])
}

// macForIP derives a stable MAC the way the CNI does: 0a:58 + the 4 IP octets.
func macForIP(ip net.IP) net.HardwareAddr {
	ip = ip.To4()
	return net.HardwareAddr{0x0a, 0x58, ip[0], ip[1], ip[2], ip[3]}
}
