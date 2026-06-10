// pigeon-cni — a CNI plugin that wires pods into the loft... or around it.
//
// Spiritual descendant of the bash CNI from
// https://www.altoros.com/blog/kubernetes-networking-writing-your-own-simple-cni-plug-in-with-bash/
// It's Go instead of bash for one hard reason: Talos Linux hosts ship no
// shell, so a script plugin physically cannot exec there.
//
// Two modes, selected by namespace:
//
//	aviary    GAME MODE. veth pair, pod end addressed from 10.244.0.0/24,
//	          host end attached to NOTHING. No bridge, no routes, no kernel
//	          forwarding — loftd taps the host end and the game does the
//	          forwarding, by conveyor belt. Port metadata is written for
//	          loftd to discover.
//
//	(else)    INFRA MODE. The Altoros algorithm, faithfully: veth pair, host
//	          end onto the cni0 bridge, pod end addressed from this node's
//	          infra subnet, default route via the bridge. ArgoCD, Traefik,
//	          CoreDNS and the game's own web server live here — they need a
//	          network that exists even when the player hasn't built one.
//
// The loft DaemonSet does node prep before any of this runs: creates cni0,
// enables forwarding, NATs the infra subnet, and writes /run/pigeon/node.json
// so we know which subnet this node owns.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/safchain/ethtool"
	"github.com/vishvananda/netlink"
	"github.com/vishvananda/netns"
	"golang.org/x/sys/unix"
)

const (
	stateDir   = "/run/pigeon"
	portsDir   = stateDir + "/ports"
	nodeFile   = stateDir + "/node.json"
	lockFile   = stateDir + "/ipam.lock"
	aviaryNS   = "aviary"
	bridgeName = "cni0"
	// Aviary is one flat L2 /16 so cross-node pods ARP each other on-link —
	// the consumer is the only router. Each node allocates from its own /24
	// inside it (10.99.<nodeOctet>.x) so node-local IPAM can't collide.
	aviaryNet = "10.99"
	firstHost = 10
	// Aviary pods default-route through the uplink gateway (10.99.0.1) so they
	// can reach the world — but only if the uplink agent is deployed AND the
	// player routes the egress frames to it. Without that, off-net traffic
	// just has nowhere to go (as it should).
	aviaryGateway = "10.99.0.1"
)

type netConf struct {
	CNIVersion string `json:"cniVersion"`
	Name       string `json:"name"`
}

// nodeInfo is written by the loft DaemonSet during node prep.
type nodeInfo struct {
	BridgeSubnet string `json:"bridgeSubnet"` // e.g. 10.244.2.0/24
	BridgeGW     string `json:"bridgeGW"`     // e.g. 10.244.2.1
	NodeOctet    int    `json:"nodeOctet"`    // this node's /24 inside the aviary /16
}

type ipamState struct {
	Next   int               `json:"next"`
	Allocs map[string]string `json:"allocs"`
}

type portMeta struct {
	Ifname      string `json:"ifname"`
	MAC         string `json:"mac"`
	IP          string `json:"ip"`
	Pod         string `json:"pod"`
	Namespace   string `json:"namespace"`
	ContainerID string `json:"containerId"`
}

func main() {
	if err := run(); err != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]any{
			"cniVersion": "1.0.0", "code": 999, "msg": err.Error(),
		})
		os.Exit(1)
	}
}

func run() error {
	switch cmd := os.Getenv("CNI_COMMAND"); cmd {
	case "VERSION":
		fmt.Println(`{"cniVersion":"1.0.0","supportedVersions":["0.3.1","0.4.0","1.0.0"]}`)
		return nil
	case "ADD":
		return cmdAdd()
	case "DEL":
		return cmdDel()
	case "CHECK", "GC", "STATUS":
		return nil
	default:
		return fmt.Errorf("unknown CNI_COMMAND %q", cmd)
	}
}

func cmdAdd() error {
	stdin, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var conf netConf
	if err := json.Unmarshal(stdin, &conf); err != nil {
		return fmt.Errorf("bad net conf: %w", err)
	}
	containerID := os.Getenv("CNI_CONTAINERID")
	netnsPath := os.Getenv("CNI_NETNS")
	ifname := os.Getenv("CNI_IFNAME")
	if containerID == "" || netnsPath == "" || ifname == "" {
		return fmt.Errorf("missing CNI_CONTAINERID/CNI_NETNS/CNI_IFNAME")
	}
	podName, podNS := podFromArgs(os.Getenv("CNI_ARGS"))
	gameMode := podNS == aviaryNS

	if err := os.MkdirAll(portsDir, 0o755); err != nil {
		return err
	}

	// Pick subnet + IPAM pool by mode.
	node, err := readNode()
	if err != nil {
		return fmt.Errorf("node not prepped by loft yet: %w", err)
	}
	var subnet, gw, pool string
	if gameMode {
		// Allocate from this node's /24, address as the flat aviary /16.
		subnet, gw, pool = fmt.Sprintf("%s.%d.0/16", aviaryNet, node.NodeOctet), "", "aviary"
	} else {
		subnet, gw, pool = node.BridgeSubnet, node.BridgeGW, "infra"
	}
	ip, err := allocIP(pool, subnet, containerID)
	if err != nil {
		return err
	}
	_, ipNet, _ := net.ParseCIDR(subnet)
	prefixLen, _ := ipNet.Mask.Size()

	// Interface names: max 15 chars. Mode prefix + first 8 of the sandbox id.
	hostName, peerName := vethNames(gameMode, containerID)

	la := netlink.NewLinkAttrs()
	la.Name = hostName
	veth := &netlink.Veth{LinkAttrs: la, PeerName: peerName}
	if err := netlink.LinkAdd(veth); err != nil {
		return fmt.Errorf("veth add: %w", err)
	}
	cleanup := func() { netlink.LinkDel(veth) }

	peer, err := netlink.LinkByName(peerName)
	if err != nil {
		cleanup()
		return err
	}
	nsHandle, err := netns.GetFromPath(netnsPath)
	if err != nil {
		cleanup()
		return fmt.Errorf("open netns %s: %w", netnsPath, err)
	}
	defer nsHandle.Close()
	if err := netlink.LinkSetNsFd(peer, int(nsHandle)); err != nil {
		cleanup()
		return fmt.Errorf("move peer into netns: %w", err)
	}

	// Inside the pod's netns: rename to eth0, address, raise. IPv6 off — the
	// loft doesn't need a blizzard of router solicitations, and infra is v4.
	var podMAC string
	err = inNetns(nsHandle, func() error {
		link, err := netlink.LinkByName(peerName)
		if err != nil {
			return err
		}
		if err := netlink.LinkSetName(link, ifname); err != nil {
			return err
		}
		for _, k := range []string{"all", "default"} {
			os.WriteFile("/proc/sys/net/ipv6/conf/"+k+"/disable_ipv6", []byte("1"), 0o644)
		}
		addr, err := netlink.ParseAddr(fmt.Sprintf("%s/%d", ip, prefixLen))
		if err != nil {
			return err
		}
		if err := netlink.AddrAdd(link, addr); err != nil {
			return err
		}
		if err := netlink.LinkSetUp(link); err != nil {
			return err
		}
		if gameMode {
			// Kill checksum offload + segmentation. The kernel normally leaves
			// TCP checksums for "hardware" to fill; our AF_PACKET tap captures
			// them unfilled and the receiving pod's kernel would drop every
			// segment. TSO/GSO would hand the tap 64KB superframes. The loft
			// wants honest wire-sized, checksummed frames.
			disableOffloads(ifname)
		}
		if gw != "" {
			// Infra pods get a real default route via cni0, like any CNI.
			route := &netlink.Route{
				LinkIndex: link.Attrs().Index,
				Gw:        net.ParseIP(gw),
			}
			if err := netlink.RouteAdd(route); err != nil {
				return fmt.Errorf("default route: %w", err)
			}
		} else if gameMode {
			// Aviary pods default-route through the uplink gateway, reachable
			// on-link over the flat L2. Best effort: it's fine if the gateway
			// IP isn't live yet — the route just won't resolve until you build
			// the path to the uplink.
			netlink.RouteAdd(&netlink.Route{
				LinkIndex: link.Attrs().Index,
				Gw:        net.ParseIP(aviaryGateway),
			})
		}
		link, err = netlink.LinkByName(ifname)
		if err != nil {
			return err
		}
		podMAC = link.Attrs().HardwareAddr.String()
		return nil
	})
	if err != nil {
		cleanup()
		return fmt.Errorf("configure pod side: %w", err)
	}

	hostLink, err := netlink.LinkByName(hostName)
	if err != nil {
		cleanup()
		return err
	}
	if gameMode {
		disableOffloads(hostName) // host side too: no GRO-merged frames at the tap
	}
	if !gameMode {
		// Infra: host end joins the bridge and the kernel does its job.
		br, err := netlink.LinkByName(bridgeName)
		if err != nil {
			cleanup()
			return fmt.Errorf("bridge %s missing (loft not running?): %w", bridgeName, err)
		}
		if err := netlink.LinkSetMaster(hostLink, br); err != nil {
			cleanup()
			return err
		}
	}
	// Game: host end joins NOTHING. loftd's packet socket is its only audience.
	if err := netlink.LinkSetUp(hostLink); err != nil {
		cleanup()
		return err
	}

	if gameMode {
		meta := portMeta{
			Ifname: hostName, MAC: podMAC, IP: ip,
			Pod: podName, Namespace: podNS, ContainerID: containerID,
		}
		metaJSON, _ := json.MarshalIndent(meta, "", "  ")
		if err := os.WriteFile(filepath.Join(portsDir, hostName+".json"), metaJSON, 0o644); err != nil {
			cleanup()
			return err
		}
	}

	ipEntry := map[string]any{
		"address":   fmt.Sprintf("%s/%d", ip, prefixLen),
		"interface": 0,
	}
	if gw != "" {
		ipEntry["gateway"] = gw
	}
	result := map[string]any{
		"cniVersion": resultVersion(conf.CNIVersion),
		"interfaces": []map[string]any{
			{"name": ifname, "mac": podMAC, "sandbox": netnsPath},
		},
		"ips": []map[string]any{ipEntry},
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func cmdDel() error {
	containerID := os.Getenv("CNI_CONTAINERID")
	if containerID == "" {
		return nil
	}
	// DEL must be idempotent and mode-agnostic: try both names, best effort.
	for _, gameMode := range []bool{true, false} {
		hostName, _ := vethNames(gameMode, containerID)
		if link, err := netlink.LinkByName(hostName); err == nil {
			netlink.LinkDel(link) // deleting one end of a veth deletes both
		}
		os.Remove(filepath.Join(portsDir, hostName+".json"))
	}
	freeIP("aviary", containerID)
	freeIP("infra", containerID)
	return nil
}

// disableOffloads turns off checksum/segmentation/receive-offload features on
// an interface, best effort per feature (names vary by kernel).
func disableOffloads(ifname string) {
	e, err := ethtool.NewEthtool()
	if err != nil {
		return
	}
	defer e.Close()
	for _, feat := range []string{
		"tx-checksum-ip-generic", "tx-checksumming",
		"tx-tcp-segmentation", "tx-tcp6-segmentation",
		"tx-generic-segmentation", "rx-gro", "tx-udp-segmentation",
	} {
		e.Change(ifname, map[string]bool{feat: false})
	}
}

func vethNames(gameMode bool, containerID string) (host, peer string) {
	short := containerID
	if len(short) > 8 {
		short = short[:8]
	}
	if gameMode {
		return "pig" + short, "pigp" + short
	}
	return "inf" + short, "infp" + short
}

func readNode() (*nodeInfo, error) {
	raw, err := os.ReadFile(nodeFile)
	if err != nil {
		return nil, err
	}
	var n nodeInfo
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, err
	}
	if n.BridgeSubnet == "" || n.BridgeGW == "" {
		return nil, fmt.Errorf("incomplete %s", nodeFile)
	}
	return &n, nil
}

// allocIP hands out the next address from a counter file, exactly like the
// bash original did with a flock'd text file — except the file is JSON now.
func allocIP(pool, subnet, containerID string) (string, error) {
	unlock, err := lock()
	if err != nil {
		return "", err
	}
	defer unlock()

	file := filepath.Join(stateDir, "ipam-"+pool+".json")
	st := ipamState{Next: firstHost, Allocs: map[string]string{}}
	if raw, err := os.ReadFile(file); err == nil {
		json.Unmarshal(raw, &st)
	}
	if st.Allocs == nil {
		st.Allocs = map[string]string{}
	}
	if ip, ok := st.Allocs[containerID]; ok {
		return ip, nil // duplicate ADD for the same sandbox: same answer
	}
	if st.Next > 250 {
		return "", fmt.Errorf("pool %s is full", pool)
	}
	base, _, err := net.ParseCIDR(subnet)
	if err != nil {
		return "", fmt.Errorf("bad subnet %q: %w", subnet, err)
	}
	ip4 := base.To4()
	ip := fmt.Sprintf("%d.%d.%d.%d", ip4[0], ip4[1], ip4[2], st.Next)
	st.Next++
	st.Allocs[containerID] = ip
	raw, _ := json.Marshal(st)
	if err := os.WriteFile(file, raw, 0o644); err != nil {
		return "", err
	}
	return ip, nil
}

func freeIP(pool, containerID string) {
	unlock, err := lock()
	if err != nil {
		return
	}
	defer unlock()
	file := filepath.Join(stateDir, "ipam-"+pool+".json")
	var st ipamState
	if raw, err := os.ReadFile(file); err == nil {
		if json.Unmarshal(raw, &st) == nil && st.Allocs != nil {
			delete(st.Allocs, containerID)
			raw, _ := json.Marshal(st)
			os.WriteFile(file, raw, 0o644)
		}
	}
}

func lock() (func(), error) {
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(lockFile, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}

// inNetns runs fn with the calling goroutine's thread switched into ns.
// Netns is per-thread, so the thread must be locked and is intentionally
// poisoned (not returned to the pool) if we fail to switch back.
func inNetns(ns netns.NsHandle, fn func() error) error {
	runtime.LockOSThread()
	origin, err := netns.Get()
	if err != nil {
		runtime.UnlockOSThread()
		return err
	}
	defer origin.Close()
	if err := netns.Set(ns); err != nil {
		runtime.UnlockOSThread()
		return err
	}
	fnErr := fn()
	if err := netns.Set(origin); err == nil {
		runtime.UnlockOSThread()
	}
	return fnErr
}

// podFromArgs digs the pod identity out of CNI_ARGS
// ("IgnoreUnknown=1;K8S_POD_NAMESPACE=default;K8S_POD_NAME=alice;...").
func podFromArgs(args string) (name, namespace string) {
	for _, kv := range strings.Split(args, ";") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch k {
		case "K8S_POD_NAME":
			name = v
		case "K8S_POD_NAMESPACE":
			namespace = v
		}
	}
	return
}

func resultVersion(v string) string {
	switch v {
	case "0.3.1", "0.4.0", "1.0.0":
		return v
	}
	return "1.0.0"
}
