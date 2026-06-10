// tunbridge — bridge a TUN device's L3 traffic onto the pigeon network,
// per-source-IP. This is the substrate for ANY L3 VPN that hands you a TUN:
// strongSwan (IKEv2, native phone/Windows clients), OpenVPN, etc. terminate
// the tunnel and route client traffic to the TUN; tunbridge turns each client
// IP into its own virtual host on the loft (own MAC, ARP responder), so on
// the factory floor every connected device is a distinct host.
//
//	client pkt --VPN decrypt--> TUN --> demux by src IP --> bridgeHost --eth--> loft
//	loft frame --> bridgeHost strips eth / answers ARP --> TUN --> VPN --> client
//
// A new bridgeHost is spun up the first time a packet from an unseen client
// IP appears, so clients are discovered dynamically as they connect.
package main

import (
	"encoding/binary"
	"flag"
	"log"
	"net"
	"os"
	"sync"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

func main() {
	gateway := flag.String("gateway", "10.5.0.2:9777", "loft gateway host:port")
	dev := flag.String("dev", "pigeonvpn", "TUN device name to create")
	gwIP := flag.String("gw-ip", "10.99.0.199", "gateway IP on the TUN")
	pool := flag.String("pool", "10.99.0.192/27", "client address pool routed into the TUN")
	flag.Parse()

	fd, err := openTun(*dev)
	if err != nil {
		log.Fatalf("create tun %s: %v (need /dev/net/tun + NET_ADMIN)", *dev, err)
	}
	if err := configureTun(*dev, *gwIP, *pool); err != nil {
		log.Fatalf("configure tun: %v", err)
	}
	log.Printf("tunbridge: %s up, gw %s, pool %s -> loft %s", *dev, *gwIP, *pool, *gateway)

	b := &bridge{loftURL: "ws://" + *gateway + "/port", tunFd: fd, hosts: map[string]*bridgeHost{}}
	go b.readTun()
	select {} // run forever
}

// ---- TUN device -------------------------------------------------------------

func openTun(name string) (int, error) {
	fd, err := unix.Open("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return -1, err
	}
	var ifr [40]byte
	copy(ifr[:], name)
	// IFF_TUN | IFF_NO_PI
	binary.LittleEndian.PutUint16(ifr[16:], unix.IFF_TUN|unix.IFF_NO_PI)
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(unix.TUNSETIFF), uintptr(unsafe.Pointer(&ifr[0]))); errno != 0 {
		unix.Close(fd)
		return -1, errno
	}
	return fd, nil
}

func configureTun(name, gwIP, pool string) error {
	link, err := netlink.LinkByName(name)
	if err != nil {
		return err
	}
	addr, _ := netlink.ParseAddr(gwIP + "/32")
	netlink.AddrAdd(link, addr)
	if err := netlink.LinkSetUp(link); err != nil {
		return err
	}
	_, dst, err := net.ParseCIDR(pool)
	if err != nil {
		return err
	}
	return netlink.RouteAdd(&netlink.Route{LinkIndex: link.Attrs().Index, Dst: dst})
}

// ---- bridge -----------------------------------------------------------------

type bridge struct {
	loftURL string
	tunFd   int
	mu      sync.Mutex
	hosts   map[string]*bridgeHost // client IP -> host
}

func (b *bridge) writeTun(ippkt []byte) {
	unix.Write(b.tunFd, ippkt)
}

func (b *bridge) readTun() {
	buf := make([]byte, 65536)
	for {
		n, err := unix.Read(b.tunFd, buf)
		if err != nil || n < 20 {
			continue
		}
		pkt := buf[:n]
		if pkt[0]>>4 != 4 {
			continue // IPv4 only for now
		}
		src := net.IP(pkt[12:16]).String()
		b.mu.Lock()
		h := b.hosts[src]
		if h == nil {
			// New client: spin up its per-peer host on the loft.
			ip := net.IP(append([]byte(nil), pkt[12:16]...))
			h = &bridgeHost{b: b, ip: ip, mac: macForIP(ip), name: "vpn-" + src, arp: map[string]net.HardwareAddr{}}
			b.hosts[src] = h
			go h.run()
		}
		b.mu.Unlock()
		cp := make([]byte, n)
		copy(cp, pkt)
		h.sendIP(cp)
	}
}

type bridgeHost struct {
	b    *bridge
	name string
	ip   net.IP
	mac  net.HardwareAddr

	mu   sync.Mutex
	conn *websocket.Conn
	arp  map[string]net.HardwareAddr
}

func (h *bridgeHost) run() {
	for {
		c, _, err := websocket.DefaultDialer.Dial(h.b.loftURL, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		c.WriteMessage(websocket.TextMessage, []byte(`{"name":"`+h.name+`","mac":"`+h.mac.String()+`","ip":"`+h.ip.String()+`"}`))
		h.mu.Lock()
		h.conn = c
		h.mu.Unlock()
		log.Printf("%s bridged (%s)", h.ip, h.mac)
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

func (h *bridgeHost) sendIP(ippkt []byte) {
	dst := net.IP(ippkt[16:20])
	h.mu.Lock()
	dmac, ok := h.arp[dst.String()]
	h.mu.Unlock()
	if !ok {
		h.arpRequest(dst)
		return
	}
	frame := make([]byte, 14+len(ippkt))
	copy(frame[0:6], dmac)
	copy(frame[6:12], h.mac)
	binary.BigEndian.PutUint16(frame[12:14], 0x0800)
	copy(frame[14:], ippkt)
	h.sendFrame(frame)
}

func (h *bridgeHost) fromAviary(b []byte) {
	if len(b) < 14 {
		return
	}
	switch binary.BigEndian.Uint16(b[12:14]) {
	case 0x0806:
		h.onARP(b)
	case 0x0800:
		if len(b) >= 34 && net.IP(b[30:34]).Equal(h.ip) {
			h.b.writeTun(b[14:]) // strip ethernet, hand the IP packet to the TUN -> VPN -> client
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
	h.mu.Lock()
	h.arp[spa.String()] = sha
	h.mu.Unlock()
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
		req[i] = 0xff
	}
	copy(req[6:12], h.mac)
	binary.BigEndian.PutUint16(req[12:14], 0x0806)
	copy(req[14:], []byte{0, 1, 8, 0, 6, 4, 0, 1})
	copy(req[22:28], h.mac)
	copy(req[28:32], h.ip)
	copy(req[38:42], target.To4())
	h.sendFrame(req)
}

func macForIP(ip net.IP) net.HardwareAddr {
	ip = ip.To4()
	return net.HardwareAddr{0x0a, 0x58, ip[0], ip[1], ip[2], ip[3]}
}
