// uplink — the gateway to the world. A host dual-homed on the pigeon network
// and the real network: aviary pods route their egress frames (through YOUR
// factory — build a firewall with filters/meters/etc) to the uplink, which
// NATs them out to the internet. apt-get update, from a pod whose only NIC is
// a conveyor belt.
//
//	aviary pod --eth(default route 10.99.0.1)--> loft --(you route it)-->
//	  uplink /port --strip eth--> TUN --> kernel ip_forward + MASQUERADE -->
//	    pod's real interface --> the internet
//	reply --> conntrack un-NAT --> route to TUN --> uplink wraps eth (ARP) -->
//	  loft --(you route it back)--> aviary pod's landing
//
// The kernel does forwarding + NAT (robust conntrack); uplink is just the
// L2<->L3 shim that registers the gateway host (10.99.0.1) on the loft, answers
// ARP for itself, and resolves aviary hosts to wrap return packets.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

func main() {
	gateway := flag.String("gateway", "10.5.0.2:9777", "loft gateway host:port")
	gwIP := flag.String("ip", "10.99.0.1", "the gateway IP aviary pods route through")
	gwMAC := flag.String("mac", "0a:58:0a:63:00:01", "the gateway MAC")
	pigeonNet := flag.String("net", "10.99.0.0/16", "the pigeon network to NAT")
	dev := flag.String("dev", "uplink0", "TUN device name")
	domain := flag.String("domain", "pigeon.isp", "DNS domain the pigeon network answers for")
	upstreamDNS := flag.String("upstream-dns", "1.1.1.1:53", "resolver to forward non-pigeon queries to")
	uiTarget := flag.String("ui-target", "http://10.5.0.2:80", "where to reverse-proxy the management UI")
	uiHost := flag.String("ui-host", "pigeon.localhost", "Host header to present to the UI target (Traefik routes on it)")
	loftHosts := flag.String("loft-hosts", "http://10.5.0.2:9777/hosts", "loft host registry for <pod>.<domain> resolution")
	flag.Parse()

	ip := net.ParseIP(*gwIP).To4()
	mac, _ := net.ParseMAC(*gwMAC)
	if ip == nil || mac == nil {
		log.Fatalf("bad ip/mac")
	}

	fd, err := openTun(*dev)
	if err != nil {
		log.Fatalf("tun %s: %v (need /dev/net/tun + NET_ADMIN)", *dev, err)
	}
	if err := setupRouting(*dev, *gwIP, *pigeonNet); err != nil {
		log.Fatalf("routing: %v", err)
	}
	log.Printf("uplink: gateway %s (%s) NATing %s to the world via %s", *gwIP, mac, *pigeonNet, *dev)

	u := &uplink{loftURL: "ws://" + *gateway + "/port", tunFd: fd, ip: ip, mac: mac, arp: map[string]net.HardwareAddr{}}

	// Services bound to the gateway IP on the TUN: the kernel delivers packets
	// addressed to 10.99.0.1 locally (and the existing readTun carries replies
	// back to the phone). So the one gateway the player routes to also resolves
	// names and serves the UI — no extra hosts to wire onto the floor.
	hosts := &hostMap{m: map[string]net.IP{}}
	go hosts.poll(*loftHosts)
	go u.serveDNS(*domain, *upstreamDNS, hosts)
	go serveUIProxy(ip, *uiTarget, *uiHost)

	go u.readTun()
	u.run()
}

// setupRouting: address the TUN as the gateway, enable forwarding, and
// MASQUERADE the pigeon net out the pod's real default interface.
func setupRouting(dev, gwIP, pigeonNet string) error {
	link, err := netlink.LinkByName(dev)
	if err != nil {
		return err
	}
	_, pnet, err := net.ParseCIDR(pigeonNet)
	if err != nil {
		return err
	}
	ones, _ := pnet.Mask.Size()
	addr, _ := netlink.ParseAddr(gwIP + "/" + itoa(ones))
	netlink.AddrAdd(link, addr) // gateway IP on the TUN, covering the pigeon net
	if err := netlink.LinkSetUp(link); err != nil {
		return err
	}

	os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0o644)

	// Find the real uplink interface (the default route's device).
	out, _ := exec.Command("sh", "-c", "ip route show default | awk '{print $5; exit}'").Output()
	wan := trim(string(out))
	if wan == "" {
		wan = "eth0"
	}
	log.Printf("uplink WAN interface: %s", wan)
	run("iptables", "-t", "nat", "-C", "POSTROUTING", "-s", pigeonNet, "-o", wan, "-j", "MASQUERADE")
	run("iptables", "-t", "nat", "-A", "POSTROUTING", "-s", pigeonNet, "-o", wan, "-j", "MASQUERADE")
	run("iptables", "-C", "FORWARD", "-j", "ACCEPT")
	run("iptables", "-A", "FORWARD", "-j", "ACCEPT")
	return nil
}

// ---- loft side --------------------------------------------------------------

type uplink struct {
	loftURL string
	tunFd   int
	ip      net.IP
	mac     net.HardwareAddr
	mu      sync.Mutex
	conn    *websocket.Conn
	arp     map[string]net.HardwareAddr // aviary host ip -> mac (for return frames)
}

func (u *uplink) run() {
	for {
		c, _, err := websocket.DefaultDialer.Dial(u.loftURL, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		c.WriteMessage(websocket.TextMessage, []byte(`{"name":"uplink","mac":"`+u.mac.String()+`","ip":"`+u.ip.String()+`"}`))
		u.mu.Lock()
		u.conn = c
		u.mu.Unlock()
		log.Printf("uplink bridged onto the pigeon network as %s", u.ip)
		for {
			mt, data, err := c.ReadMessage()
			if err != nil {
				break
			}
			if mt == websocket.BinaryMessage {
				u.fromAviary(data)
			}
		}
		u.mu.Lock()
		u.conn = nil
		u.mu.Unlock()
		time.Sleep(2 * time.Second)
	}
}

func (u *uplink) sendFrame(frame []byte) {
	u.mu.Lock()
	c := u.conn
	if c != nil {
		c.WriteMessage(websocket.BinaryMessage, frame)
	}
	u.mu.Unlock()
}

// fromAviary: a frame the player routed to the uplink. Answer ARP for the
// gateway; forward IP packets to the kernel (TUN) for NAT.
func (u *uplink) fromAviary(b []byte) {
	if len(b) < 14 {
		return
	}
	switch binary.BigEndian.Uint16(b[12:14]) {
	case 0x0806:
		u.onARP(b)
	case 0x0800:
		if len(b) < 34 {
			return
		}
		// learn the sender so we can wrap its return traffic
		src := net.IP(append([]byte(nil), b[26:30]...))
		u.mu.Lock()
		u.arp[src.String()] = net.HardwareAddr(append([]byte(nil), b[6:12]...))
		u.mu.Unlock()
		unix.Write(u.tunFd, b[14:]) // hand the IP packet to the kernel -> forward + MASQUERADE
	}
}

func (u *uplink) onARP(b []byte) {
	if len(b) < 42 {
		return
	}
	oper := binary.BigEndian.Uint16(b[20:22])
	sha := net.HardwareAddr(append([]byte(nil), b[22:28]...))
	spa := net.IP(append([]byte(nil), b[28:32]...))
	tpa := net.IP(b[38:42])
	u.mu.Lock()
	u.arp[spa.String()] = sha
	u.mu.Unlock()
	if oper == 1 && tpa.Equal(u.ip) {
		reply := make([]byte, 42)
		copy(reply[0:6], sha)
		copy(reply[6:12], u.mac)
		binary.BigEndian.PutUint16(reply[12:14], 0x0806)
		copy(reply[14:], []byte{0, 1, 8, 0, 6, 4, 0, 2})
		copy(reply[22:28], u.mac)
		copy(reply[28:32], u.ip)
		copy(reply[32:38], sha)
		copy(reply[38:42], spa)
		u.sendFrame(reply)
	}
}

// readTun: return packets the kernel routed back to the pigeon net. Wrap each
// in ethernet toward the destination aviary host and send to the loft.
func (u *uplink) readTun() {
	buf := make([]byte, 65536)
	for {
		n, err := unix.Read(u.tunFd, buf)
		if err != nil || n < 20 {
			continue
		}
		if buf[0]>>4 != 4 {
			continue
		}
		dst := net.IP(append([]byte(nil), buf[16:20]...))
		u.mu.Lock()
		dmac, ok := u.arp[dst.String()]
		u.mu.Unlock()
		if !ok {
			continue // no MAC for the host yet; it'll retry / re-ARP
		}
		frame := make([]byte, 14+n)
		copy(frame[0:6], dmac)
		copy(frame[6:12], u.mac)
		binary.BigEndian.PutUint16(frame[12:14], 0x0800)
		copy(frame[14:], buf[:n])
		u.sendFrame(frame)
	}
}

// ---- DNS: name the network ---------------------------------------------------

// hostMap is the pigeon name->IP table, refreshed from the loft registry, so
// <pod>.<domain> resolves to the host's aviary IP.
type hostMap struct {
	mu sync.RWMutex
	m  map[string]net.IP
}

func (h *hostMap) lookup(label string) net.IP {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.m[label]
}

func (h *hostMap) poll(url string) {
	for {
		if url != "" {
			if resp, err := http.Get(url); err == nil {
				var body struct {
					Hosts []struct{ Name, IP string }
				}
				json.NewDecoder(resp.Body).Decode(&body)
				resp.Body.Close()
				nm := map[string]net.IP{}
				for _, e := range body.Hosts {
					if ip := net.ParseIP(e.IP); ip != nil && e.Name != "" {
						nm[strings.ToLower(e.Name)] = ip.To4()
					}
				}
				h.mu.Lock()
				h.m = nm
				h.mu.Unlock()
			}
		}
		time.Sleep(5 * time.Second)
	}
}

// serveDNS answers A queries for <domain> from the host map (plus the gateway's
// own aliases) and forwards everything else to an upstream resolver. The phone's
// query only arrives here if the player carried it across the floor — so even
// DNS is something you route.
func (u *uplink) serveDNS(domain, upstream string, hosts *hostMap) {
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	addr := &net.UDPAddr{IP: u.ip, Port: 53}
	var pc *net.UDPConn
	for i := 0; i < 40; i++ {
		c, err := net.ListenUDP("udp4", addr)
		if err == nil {
			pc = c
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if pc == nil {
		log.Printf("dns: could not bind %s:53", u.ip)
		return
	}
	log.Printf("dns: answering *.%s on %s:53 (upstream %s)", domain, u.ip, upstream)
	buf := make([]byte, 1500)
	for {
		n, caddr, err := pc.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		q := make([]byte, n)
		copy(q, buf[:n])
		go u.handleDNS(pc, caddr, q, domain, upstream, hosts)
	}
}

func (u *uplink) handleDNS(pc *net.UDPConn, caddr *net.UDPAddr, q []byte, domain, upstream string, hosts *hostMap) {
	name, qtype, ok := parseQuestion(q)
	if ok && (name == domain || strings.HasSuffix(name, "."+domain)) {
		if qtype == 1 { // A
			if ip := u.resolveLocal(name, domain, hosts); ip != nil {
				pc.WriteToUDP(buildA(q, ip), caddr)
				return
			}
			pc.WriteToUDP(dnsHeaderOnly(q, 3), caddr) // NXDOMAIN
			return
		}
		// No AAAA / other records for pigeon names — empty NOERROR so clients
		// fall back to the A answer.
		pc.WriteToUDP(dnsHeaderOnly(q, 0), caddr)
		return
	}
	if resp, err := forwardDNS(upstream, q); err == nil {
		pc.WriteToUDP(resp, caddr)
	}
}

// resolveLocal maps a name under our domain to an aviary IP. The gateway itself
// answers to a few friendly aliases (ui/gateway/router) — that's where the UI
// proxy lives.
func (u *uplink) resolveLocal(name, domain string, hosts *hostMap) net.IP {
	label := strings.TrimSuffix(strings.ToLower(name), domain)
	label = strings.TrimSuffix(label, ".")
	switch label {
	case "", "ui", "gateway", "router", "uplink", "pigeon":
		return u.ip
	}
	return hosts.lookup(label)
}

func forwardDNS(upstream string, q []byte) ([]byte, error) {
	c, err := net.DialTimeout("udp", upstream, 3*time.Second)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(4 * time.Second))
	if _, err := c.Write(q); err != nil {
		return nil, err
	}
	resp := make([]byte, 1500)
	n, err := c.Read(resp)
	if err != nil {
		return nil, err
	}
	return resp[:n], nil
}

// parseQuestion pulls the first question's lowercased name and qtype out of a
// DNS message. Question names never use compression, so a straight walk is safe.
func parseQuestion(msg []byte) (name string, qtype uint16, ok bool) {
	if len(msg) < 12 || binary.BigEndian.Uint16(msg[4:6]) < 1 {
		return "", 0, false
	}
	off := 12
	var labels []string
	for off < len(msg) {
		n := int(msg[off])
		off++
		if n == 0 {
			break
		}
		if n&0xc0 != 0 || off+n > len(msg) {
			return "", 0, false
		}
		labels = append(labels, string(msg[off:off+n]))
		off += n
	}
	if off+4 > len(msg) {
		return "", 0, false
	}
	return strings.ToLower(strings.Join(labels, ".")), binary.BigEndian.Uint16(msg[off : off+2]), true
}

func questionEnd(msg []byte) int {
	off := 12
	for off < len(msg) {
		n := int(msg[off])
		off++
		if n == 0 {
			break
		}
		off += n
	}
	return off + 4 // qtype + qclass
}

// buildA echoes the query and appends one A record pointing at ip.
func buildA(q []byte, ip net.IP) []byte {
	end := questionEnd(q)
	if end > len(q) {
		return dnsHeaderOnly(q, 2)
	}
	resp := make([]byte, end, end+16)
	copy(resp, q[:end])
	resp[2] |= 0x84       // QR + AA
	resp[3] = 0x80        // RA, rcode 0
	binary.BigEndian.PutUint16(resp[6:8], 1)   // ancount
	binary.BigEndian.PutUint16(resp[8:10], 0)  // nscount
	binary.BigEndian.PutUint16(resp[10:12], 0) // arcount
	ans := []byte{0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4}
	resp = append(resp, ans...)
	return append(resp, ip.To4()...)
}

// dnsHeaderOnly returns the query as an answer with the given rcode and no
// records (NXDOMAIN=3, empty NOERROR=0).
func dnsHeaderOnly(q []byte, rcode byte) []byte {
	end := questionEnd(q)
	if end > len(q) {
		end = len(q)
	}
	resp := make([]byte, end)
	copy(resp, q[:end])
	if len(resp) >= 12 {
		resp[2] |= 0x84
		resp[3] = 0x80 | (rcode & 0x0f)
		binary.BigEndian.PutUint16(resp[6:8], 0)
		binary.BigEndian.PutUint16(resp[8:10], 0)
		binary.BigEndian.PutUint16(resp[10:12], 0)
	}
	return resp
}

// ---- UI proxy: the management console, reachable through the tunnel ----------

// serveUIProxy reverse-proxies http://<gateway>/ to the in-cluster ingress,
// rewriting Host so Traefik serves the game UI. A joined device can browse to
// ui.<domain> (resolved to the gateway) and reach the console — but only over
// the tunnel, so it's gated by VPN membership.
func serveUIProxy(self net.IP, target, hostHeader string) {
	t, err := url.Parse(target)
	if err != nil {
		log.Printf("ui proxy: bad target %s: %v", target, err)
		return
	}
	rp := httputil.NewSingleHostReverseProxy(t)
	director := rp.Director
	rp.Director = func(r *http.Request) {
		director(r)
		r.Host = hostHeader // Traefik routes on Host; present the UI's vhost
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "ui upstream unreachable: "+err.Error(), http.StatusBadGateway)
	}

	addr := net.JoinHostPort(self.String(), "80")
	var ln net.Listener
	for i := 0; i < 40; i++ {
		l, err := net.Listen("tcp", addr)
		if err == nil {
			ln = l
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if ln == nil {
		log.Printf("ui proxy: could not bind %s", addr)
		return
	}
	log.Printf("ui proxy: %s -> %s (Host: %s)", addr, target, hostHeader)
	http.Serve(ln, rp)
}

// ---- helpers ----------------------------------------------------------------

func openTun(name string) (int, error) {
	fd, err := unix.Open("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return -1, err
	}
	var ifr [40]byte
	copy(ifr[:], name)
	binary.LittleEndian.PutUint16(ifr[16:], unix.IFF_TUN|unix.IFF_NO_PI)
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(unix.TUNSETIFF), uintptr(unsafe.Pointer(&ifr[0]))); errno != 0 {
		unix.Close(fd)
		return -1, errno
	}
	return fd, nil
}

func run(args ...string) {
	exec.Command(args[0], args[1:]...).Run()
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [12]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func trim(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	return s
}
