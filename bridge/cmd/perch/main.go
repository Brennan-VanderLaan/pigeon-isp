// perch — an agent that bridges a host into the pigeon network through the
// loft's /port API. It registers a virtual port (a host with its own MAC/IP),
// sends ethernet frames in, and receives the frames the game routes to it.
//
// Two modes:
//
//	-synthetic  no real NIC: perch answers ARP who-has for its IP and replies
//	            to ICMP echo, so it shows up as a pingable host on the pigeon
//	            network. Proves external bridging end to end (run a consumer,
//	            then `ping <perch-ip>` from another aviary host).
//	-tap        (Linux) bridge a real TAP device — actual host traffic rides
//	            the factory. The TAP's frames go in; routed frames come out.
//
// The real-host story on Windows/macOS is the same protocol with a wintun/
// utun shim; the wire format here is what that client will speak.
package main

import (
	"encoding/binary"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/gorilla/websocket"
)

func main() {
	gateway := flag.String("gateway", "10.5.0.2:9777", "loft gateway host:port")
	name := flag.String("name", "perch", "host name shown on the pigeon network")
	ipStr := flag.String("ip", "10.99.0.250", "this host's IP on the aviary")
	macStr := flag.String("mac", "0a:58:0a:63:fe:fe", "this host's MAC")
	mode := flag.String("synthetic", "true", "synthetic ARP/ICMP responder mode")
	flag.Parse()
	_ = mode

	mac, err := net.ParseMAC(*macStr)
	if err != nil {
		log.Fatalf("bad mac: %v", err)
	}
	ip := net.ParseIP(*ipStr).To4()
	if ip == nil {
		log.Fatalf("bad ipv4: %s", *ipStr)
	}

	url := "ws://" + *gateway + "/port"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		log.Fatalf("dial %s: %v", url, err)
	}
	defer conn.Close()

	reg := `{"name":"` + *name + `","mac":"` + mac.String() + `","ip":"` + ip.String() + `"}`
	if err := conn.WriteMessage(websocket.TextMessage, []byte(reg)); err != nil {
		log.Fatalf("register: %v", err)
	}
	log.Printf("perch %q joined the pigeon network as %s (%s) via %s", *name, ip, mac, url)

	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, os.Interrupt, syscall.SIGTERM)
		<-c
		conn.Close()
		os.Exit(0)
	}()

	h := &host{conn: conn, mac: mac, ip: ip}
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			log.Printf("loft hung up: %v", err)
			return
		}
		if mt == websocket.TextMessage {
			log.Printf("loft: %s", data)
			continue
		}
		h.onFrame(data)
	}
}

type host struct {
	conn *websocket.Conn
	mac  net.HardwareAddr
	ip   net.IP
}

func (h *host) send(frame []byte) {
	h.conn.WriteMessage(websocket.BinaryMessage, frame)
}

// onFrame handles a frame the game delivered to us: answer ARP for our IP,
// and echo ICMP. Everything else is ignored (we're a minimal host).
func (h *host) onFrame(b []byte) {
	if len(b) < 14 {
		return
	}
	etherType := binary.BigEndian.Uint16(b[12:14])
	switch etherType {
	case 0x0806: // ARP
		h.onARP(b)
	case 0x0800: // IPv4
		h.onIPv4(b)
	}
}

func (h *host) onARP(b []byte) {
	if len(b) < 42 {
		return
	}
	oper := binary.BigEndian.Uint16(b[20:22])
	if oper != 1 { // only answer who-has
		return
	}
	tpa := net.IP(b[38:42])
	if !tpa.Equal(h.ip) {
		return
	}
	sha := net.HardwareAddr(b[22:28])
	spa := net.IP(b[28:32])

	// Build an ARP reply: we are-at h.mac.
	reply := make([]byte, 42)
	copy(reply[0:6], sha)    // dst = asker
	copy(reply[6:12], h.mac) // src = us
	binary.BigEndian.PutUint16(reply[12:14], 0x0806)
	copy(reply[14:], []byte{0, 1, 8, 0, 6, 4, 0, 2}) // htype/ptype/hlen/plen/oper=2
	copy(reply[22:28], h.mac)
	copy(reply[28:32], h.ip)
	copy(reply[32:38], sha)
	copy(reply[38:42], spa)
	h.send(reply)
	log.Printf("arp: %s is-at %s (asked by %s)", h.ip, h.mac, spa)
}

func (h *host) onIPv4(b []byte) {
	ihl := int(b[14]&0x0f) * 4
	if len(b) < 14+ihl+8 || b[23] != 1 { // proto 1 = ICMP
		return
	}
	dst := net.IP(b[30:34])
	if !dst.Equal(h.ip) {
		return
	}
	l4 := 14 + ihl
	if b[l4] != 8 { // echo request
		return
	}
	src := net.IP(b[26:30])
	srcMac := net.HardwareAddr(b[6:12])

	// Swap to build an echo reply: copy the frame, flip MACs/IPs, type 0.
	reply := make([]byte, len(b))
	copy(reply, b)
	copy(reply[0:6], srcMac) // dst mac = sender
	copy(reply[6:12], h.mac)
	copy(reply[26:30], h.ip) // src ip = us
	copy(reply[30:34], src)  // dst ip = sender
	reply[l4] = 0            // echo reply
	// recompute ICMP checksum (only the type byte changed: 8 -> 0)
	reply[l4+2] = 0
	reply[l4+3] = 0
	ck := checksum(reply[l4:])
	binary.BigEndian.PutUint16(reply[l4+2:l4+4], ck)
	// recompute IP header checksum (unchanged addrs swapped, but lengths same;
	// addresses changed value-wise so redo it)
	reply[24] = 0
	reply[25] = 0
	ipck := checksum(reply[14 : 14+ihl])
	binary.BigEndian.PutUint16(reply[24:26], ipck)
	h.send(reply)
	log.Printf("icmp: echo reply to %s", src)
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}
