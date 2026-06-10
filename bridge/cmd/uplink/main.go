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
	"flag"
	"log"
	"net"
	"os"
	"os/exec"
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
