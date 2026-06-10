// tower — the control tower: admin telemetry + benchmark trigger API.
//
// Speedtest-for-Pigeon-ISP: the same iperf3 run, two ways —
//
//	baseline  tower's own pod (infra network) -> baseline-server pod on
//	          another node. Kernel routing all the way: this is what the
//	          node network can practically do.
//	pigeon    exec into aviary/bench-client -> bench-server (different node,
//	          aviary network). Every frame rides the loft mesh and a consumer
//	          must be routing. The gap between the two numbers IS the product.
//
// Plus /api/health and /api/usage: nodes, pods, per-node loft+trunk state,
// and kubelet stats/summary (CPU/mem) without needing metrics-server.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

var (
	cfg       *rest.Config
	clientset *kubernetes.Clientset
	httpc     = &http.Client{Timeout: 5 * time.Second}
)

func main() {
	var err error
	cfg, err = rest.InClusterConfig()
	if err != nil {
		log.Fatalf("in-cluster config: %v", err)
	}
	clientset, err = kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("clientset: %v", err)
	}

	http.HandleFunc("/api/health", withJSON(health))
	http.HandleFunc("/api/usage", withJSON(usage))
	http.HandleFunc("/api/topology", withJSON(topology))
	http.HandleFunc("/api/run", runBench)
	http.HandleFunc("/api/hosts", hosts)                   // GET list, POST spawn, DELETE remove
	http.HandleFunc("/api/shell", shell)                   // WebSocket: live TTY (new or ?session= rejoin)
	http.HandleFunc("/api/shells", withJSON(shellList))    // list live sessions to rejoin
	http.HandleFunc("/api/workloads", workloads)           // GET list, POST create+start, DELETE stop
	http.HandleFunc("/api/workloads/run", workloadRunOnce) // POST: trigger one immediate run
	http.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"unknown endpoint"}`, 404)
	})

	log.Println("tower: watching the lofts on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func withJSON(fn func(ctx context.Context) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		out, err := fn(ctx)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(out)
	}
}

// ---- /api/health -------------------------------------------------------------

func health(ctx context.Context) (any, error) {
	nodes, err := clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	pods, err := clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	nodeOut := []map[string]any{}
	for _, n := range nodes.Items {
		ready := false
		for _, c := range n.Status.Conditions {
			if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
				ready = true
			}
		}
		ip := nodeIP(&n)
		entry := map[string]any{
			"name": n.Name, "ready": ready, "ip": ip,
			"kubelet": n.Status.NodeInfo.KubeletVersion,
			"os":      n.Status.NodeInfo.OSImage,
		}
		// Each node's loft answers on :9777 with role/ports/buffer/drops.
		if loft := fetchLoft(ip, "/"); loft != nil {
			entry["loft"] = loft
		}
		nodeOut = append(nodeOut, entry)
	}

	nsCounts := map[string]map[string]int{}
	problems := []map[string]string{}
	for _, p := range pods.Items {
		c := nsCounts[p.Namespace]
		if c == nil {
			c = map[string]int{}
			nsCounts[p.Namespace] = c
		}
		c[string(p.Status.Phase)]++
		if p.Status.Phase != corev1.PodRunning && p.Status.Phase != corev1.PodSucceeded {
			problems = append(problems, map[string]string{
				"pod": p.Namespace + "/" + p.Name, "phase": string(p.Status.Phase), "node": p.Spec.NodeName,
			})
		}
		for _, cs := range p.Status.ContainerStatuses {
			if cs.RestartCount > 3 {
				problems = append(problems, map[string]string{
					"pod": p.Namespace + "/" + p.Name, "phase": fmt.Sprintf("restarts=%d", cs.RestartCount), "node": p.Spec.NodeName,
				})
			}
		}
	}
	return map[string]any{
		"nodes": nodeOut, "namespaces": nsCounts, "problems": problems,
		"time": time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// ---- /api/usage (kubelet stats/summary via the API server proxy) ---------------

func usage(ctx context.Context) (any, error) {
	nodes, err := clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, n := range nodes.Items {
		raw, err := clientset.CoreV1().RESTClient().Get().
			Resource("nodes").Name(n.Name).SubResource("proxy").
			Suffix("stats/summary").DoRaw(ctx)
		entry := map[string]any{"name": n.Name}
		if err == nil {
			var sum struct {
				Node struct {
					CPU    struct{ UsageNanoCores uint64 }           `json:"cpu"`
					Memory struct{ WorkingSetBytes uint64 }          `json:"memory"`
					Fs     struct{ UsedBytes, CapacityBytes uint64 } `json:"fs"`
				} `json:"node"`
				Pods []struct {
					PodRef struct{ Name, Namespace string } `json:"podRef"`
					CPU    struct{ UsageNanoCores uint64 }  `json:"cpu"`
					Memory struct{ WorkingSetBytes uint64 } `json:"memory"`
				} `json:"pods"`
			}
			if json.Unmarshal(raw, &sum) == nil {
				entry["cpuMillicores"] = sum.Node.CPU.UsageNanoCores / 1e6
				entry["memBytes"] = sum.Node.Memory.WorkingSetBytes
				entry["fsUsedBytes"] = sum.Node.Fs.UsedBytes
				entry["fsCapacityBytes"] = sum.Node.Fs.CapacityBytes
				allocatable := n.Status.Allocatable
				if cpu := allocatable.Cpu(); cpu != nil {
					entry["cpuCapacityMillicores"] = cpu.MilliValue()
				}
				if mem := allocatable.Memory(); mem != nil {
					entry["memCapacityBytes"] = mem.Value()
				}
				top := []map[string]any{}
				for _, p := range sum.Pods {
					if p.CPU.UsageNanoCores > 0 {
						top = append(top, map[string]any{
							"pod":           p.PodRef.Namespace + "/" + p.PodRef.Name,
							"cpuMillicores": p.CPU.UsageNanoCores / 1e6,
							"memBytes":      p.Memory.WorkingSetBytes,
						})
					}
				}
				entry["pods"] = top
			}
		} else {
			entry["error"] = err.Error()
		}
		out = append(out, entry)
	}
	return map[string]any{"nodes": out}, nil
}

// ---- /api/topology -------------------------------------------------------------

func topology(ctx context.Context) (any, error) {
	pods, err := clientset.CoreV1().Pods("aviary").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := []map[string]string{}
	for _, p := range pods.Items {
		out = append(out, map[string]string{
			"pod": p.Name, "ip": p.Status.PodIP, "node": p.Spec.NodeName, "phase": string(p.Status.Phase),
		})
	}
	return map[string]any{"aviary": out}, nil
}

// ---- /api/run: the speedtest ----------------------------------------------------

type runReq struct {
	Test      string `json:"test"`      // "baseline" | "pigeon"
	Proto     string `json:"proto"`     // "tcp" | "udp"
	Seconds   int    `json:"seconds"`   // default 10
	Rate      string `json:"rate"`      // udp target, default "100M"
	Direction string `json:"direction"` // "up" | "down" | "both" (default both)
	Parallel  int    `json:"parallel"`  // iperf3 -P streams, default 1
}

func runBench(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"POST only"}`, 405)
		return
	}
	var req runReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad body"}`, 400)
		return
	}
	if req.Seconds <= 0 || req.Seconds > 60 {
		req.Seconds = 10
	}
	if req.Rate == "" {
		req.Rate = "100M"
	}
	if req.Parallel <= 0 || req.Parallel > 32 {
		req.Parallel = 1
	}
	if req.Direction == "" {
		req.Direction = "both"
	}
	if req.Test != "baseline" && req.Test != "pigeon" {
		http.Error(w, `{"error":"test must be baseline|pigeon"}`, 400)
		return
	}

	// Direction → which iperf passes to run. "up" is client→server (the
	// host transmitting); "down" is the reverse (-R, server→host). "both"
	// runs them sequentially so up and down don't contend for the floor —
	// and so an ASYMMETRIC route (different belts each way) shows up as
	// different numbers.
	dirs := []string{}
	switch req.Direction {
	case "up":
		dirs = []string{"up"}
	case "down":
		dirs = []string{"down"}
	default:
		dirs = []string{"up", "down"}
	}

	// Per-direction timeout budget.
	budget := time.Duration((req.Seconds+20)*len(dirs)+15) * time.Second
	ctx, cancel := context.WithTimeout(r.Context(), budget)
	defer cancel()

	before := loftStatsAll(ctx)
	results := []map[string]any{}
	var rtt map[string]any
	var serverNode string
	for _, dir := range dirs {
		one, node, rt, err := runDirection(ctx, req, dir)
		if err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		serverNode = node
		if rt != nil {
			rtt = rt
		}
		results = append(results, one)
	}

	out := map[string]any{
		"test": req.Test, "proto": req.Proto, "parallel": req.Parallel,
		"serverNode": serverNode, "rtt": rtt, "directions": results,
		"loftStatsBefore": before, "loftStatsAfter": loftStatsAll(ctx),
	}
	json.NewEncoder(w).Encode(out)
}

// runDirection runs one iperf3 pass (up or down) for the selected test, plus a
// one-time RTT probe (only on the first pass — RTT doesn't have a direction
// here). Returns the direction result, the server node, and rtt (or nil).
func runDirection(ctx context.Context, req runReq, dir string) (map[string]any, string, map[string]any, error) {
	reverse := dir == "down"
	var ip, node, rttOut string
	var iperfOut string
	wantRTT := dir == "up" || req.Direction == "down"

	if req.Test == "baseline" {
		var err error
		ip, node, err = podIP(ctx, "pigeon-system", "baseline-server")
		if err != nil {
			return nil, "", nil, err
		}
		if wantRTT {
			rttOut = localRun(ctx, "ping", "-c", "5", "-W", "2", ip)
		}
		iperfOut = localRun(ctx, iperfArgs(ip, req, reverse)...)
	} else {
		var err error
		ip, node, err = podIP(ctx, "aviary", "bench-server")
		if err != nil {
			return nil, "", nil, err
		}
		if wantRTT {
			rttOut, _ = podExec(ctx, "aviary", "alice", []string{"ping", "-c", "5", "-W", "3", ip})
		}
		iperfOut, err = podExec(ctx, "aviary", "bench-client", iperfArgs(ip, req, reverse))
		if err != nil && !strings.Contains(iperfOut, "{") {
			return nil, "", nil, fmt.Errorf("exec iperf3 (%s): %v (%s)", dir, err, firstLine(iperfOut))
		}
	}

	var rtt map[string]any
	if wantRTT {
		rtt, _ = parsePing(rttOut)
	}
	return map[string]any{"direction": dir, "iperf": parseIperf(iperfOut)}, node, rtt, nil
}

func iperfArgs(ip string, req runReq, reverse bool) []string {
	args := []string{"iperf3", "-c", ip, "-t", strconv.Itoa(req.Seconds), "--json", "--connect-timeout", "5000"}
	if req.Parallel > 1 {
		args = append(args, "-P", strconv.Itoa(req.Parallel))
	}
	if reverse {
		args = append(args, "-R") // server → client (the "down" direction)
	}
	if req.Proto == "udp" {
		args = append(args, "-u", "-b", req.Rate)
	}
	return args
}

// ---- helpers ---------------------------------------------------------------------

func nodeIP(n *corev1.Node) string {
	for _, a := range n.Status.Addresses {
		if a.Type == corev1.NodeInternalIP {
			return a.Address
		}
	}
	return ""
}

func fetchLoft(ip, path string) map[string]any {
	if ip == "" {
		return nil
	}
	resp, err := httpc.Get("http://" + ip + ":9777" + path)
	if err != nil {
		return map[string]any{"error": "unreachable"}
	}
	defer resp.Body.Close()
	var out map[string]any
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out) != nil {
		return nil
	}
	return out
}

func loftStatsAll(ctx context.Context) map[string]any {
	out := map[string]any{}
	nodes, err := clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for _, n := range nodes.Items {
		if s := fetchLoft(nodeIP(&n), "/stats"); s != nil {
			out[n.Name] = s
		}
	}
	return out
}

func podIP(ctx context.Context, ns, name string) (ip, node string, err error) {
	p, err := clientset.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", "", fmt.Errorf("pod %s/%s: %w", ns, name, err)
	}
	if p.Status.PodIP == "" {
		return "", "", fmt.Errorf("pod %s/%s has no IP yet", ns, name)
	}
	return p.Status.PodIP, p.Spec.NodeName, nil
}

func localRun(ctx context.Context, args ...string) string {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	out, _ := cmd.CombinedOutput()
	return string(out)
}

func podExec(ctx context.Context, ns, pod string, command []string) (string, error) {
	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Command: command, Stdout: true, Stderr: true,
		}, scheme.ParameterCodec)
	executor, err := remotecommand.NewSPDYExecutor(cfg, "POST", req.URL())
	if err != nil {
		return "", err
	}
	var stdout, stderr bytes.Buffer
	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &stdout, Stderr: &stderr})
	return stdout.String() + stderr.String(), err
}

// parseIperf pulls the numbers a speedtest UI wants out of iperf3 --json.
func parseIperf(out string) map[string]any {
	i := strings.Index(out, "{")
	if i < 0 {
		return map[string]any{"error": firstLine(out)}
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(out[i:]), &raw); err != nil {
		return map[string]any{"error": firstLine(out)}
	}
	res := map[string]any{}
	if e, ok := raw["end"].(map[string]any); ok {
		if s, ok := e["sum_received"].(map[string]any); ok {
			res["mbps"] = round2(getF(s, "bits_per_second") / 1e6)
			res["bytes"] = getF(s, "bytes")
		}
		if s, ok := e["sum_sent"].(map[string]any); ok {
			res["sentMbps"] = round2(getF(s, "bits_per_second") / 1e6)
			res["retransmits"] = getF(s, "retransmits")
		}
		if s, ok := e["sum"].(map[string]any); ok { // udp
			if _, have := res["mbps"]; !have {
				res["mbps"] = round2(getF(s, "bits_per_second") / 1e6)
			}
			res["jitterMs"] = round2(getF(s, "jitter_ms"))
			res["lostPackets"] = getF(s, "lost_packets")
			res["packets"] = getF(s, "packets")
			res["lostPercent"] = round2(getF(s, "lost_percent"))
		}
	}
	if err, ok := raw["error"].(string); ok {
		res["error"] = err
	}
	return res
}

var pingRTT = regexp.MustCompile(`= ([\d.]+)/([\d.]+)/([\d.]+)`)
var pingLoss = regexp.MustCompile(`(\d+)% packet loss`)

func parsePing(out string) (map[string]any, error) {
	res := map[string]any{}
	if m := pingRTT.FindStringSubmatch(out); m != nil {
		res["minMs"], _ = strconv.ParseFloat(m[1], 64)
		res["avgMs"], _ = strconv.ParseFloat(m[2], 64)
		res["maxMs"], _ = strconv.ParseFloat(m[3], 64)
	}
	if m := pingLoss.FindStringSubmatch(out); m != nil {
		res["lossPercent"], _ = strconv.Atoi(m[1])
	}
	if len(res) == 0 {
		return nil, fmt.Errorf("ping produced nothing")
	}
	return res, nil
}

func getF(m map[string]any, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}

func round2(f float64) float64 { return float64(int(f*100)) / 100 }

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i > 0 {
		return s[:i]
	}
	return s
}
