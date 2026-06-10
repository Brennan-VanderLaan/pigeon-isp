// workloads — recurring traffic generators. A workload periodically execs a
// command inside an aviary pod (wget a URL, run an iperf3 transfer, ping a
// target) on a fixed interval in a background goroutine, remembering its last
// result. They give the player's router something to actually route: idle
// aviaries are boring; a loft mesh under steady traffic is the product.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const maxOutput = 2 << 10 // truncate stored output to ~2KB

// workload is one recurring traffic generator. Mutable run state (running,
// lastRunAt, lastOk, lastOutput, runs) is guarded by the registry mutex; the
// immutable config fields are set once at create time and read freely.
type workload struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Pod      string `json:"pod"`
	NS       string `json:"ns"`
	Kind     string `json:"kind"`   // wget|ping|iperf|custom
	Target   string `json:"target"` // URL, IP, or raw shell command
	Interval int    `json:"intervalSeconds"`

	Running    bool   `json:"running"`
	LastRunAt  string `json:"lastRunAt"` // RFC3339, or "" if never run
	LastOk     bool   `json:"lastOk"`
	LastOutput string `json:"lastOutput"`
	Runs       int    `json:"runs"`

	cmd  []string      // resolved exec command
	stop chan struct{} // closed by DELETE to halt loop()
	once sync.Once     // guards stop being closed exactly once
}

// workloadArgs are per-kind knobs supplied at create time.
type workloadArgs struct {
	Count   int `json:"count"`   // ping -c
	Seconds int `json:"seconds"` // iperf -t
}

type workloadReq struct {
	Name     string       `json:"name"`
	Pod      string       `json:"pod"`
	NS       string       `json:"ns"`
	Kind     string       `json:"kind"`
	Target   string       `json:"target"`
	Interval int          `json:"intervalSeconds"`
	Args     workloadArgs `json:"args"`
}

// registry is the in-memory set of live workloads.
type registry struct {
	mu  sync.Mutex
	m   map[string]*workload
	seq int
}

var workloadReg = &registry{m: map[string]*workload{}}

// snapshot reads a workload's state under the registry lock and returns a plain
// map for JSON. Caller must NOT already hold the lock.
func (wl *workload) snapshot() map[string]any {
	workloadReg.mu.Lock()
	defer workloadReg.mu.Unlock()
	return map[string]any{
		"id":              wl.ID,
		"name":            wl.Name,
		"pod":             wl.Pod,
		"ns":              wl.NS,
		"kind":            wl.Kind,
		"target":          wl.Target,
		"intervalSeconds": wl.Interval,
		"running":         wl.Running,
		"lastRunAt":       wl.LastRunAt,
		"lastOk":          wl.LastOk,
		"lastOutput":      wl.LastOutput,
		"runs":            wl.Runs,
	}
}

// workloads routes /api/workloads by method. (withJSON is GET-shaped; create
// needs the body, so this handler is raw like hosts.)
func workloads(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listWorkloads(w, r)
	case http.MethodPost:
		createWorkload(w, r)
	case http.MethodDelete:
		deleteWorkload(w, r)
	default:
		http.Error(w, `{"error":"GET|POST|DELETE only"}`, 405)
	}
}

func listWorkloads(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	workloadReg.mu.Lock()
	out := make([]map[string]any, 0, len(workloadReg.m))
	for _, wl := range workloadReg.m {
		out = append(out, map[string]any{
			"id":              wl.ID,
			"name":            wl.Name,
			"pod":             wl.Pod,
			"ns":              wl.NS,
			"kind":            wl.Kind,
			"target":          wl.Target,
			"intervalSeconds": wl.Interval,
			"running":         wl.Running,
			"lastRunAt":       wl.LastRunAt,
			"lastOk":          wl.LastOk,
			"lastOutput":      wl.LastOutput,
			"runs":            wl.Runs,
		})
	}
	workloadReg.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{"workloads": out})
}

// resolveCmd builds the exec command for a kind. Returns ok=false on unknown
// kind. target/pod emptiness is validated by the caller.
func resolveCmd(kind, target string, args workloadArgs) (cmd []string, ok bool) {
	switch kind {
	case "wget":
		return []string{"sh", "-c", fmt.Sprintf("wget -q -O /dev/null -T 5 %s && echo OK || echo FAIL", target)}, true
	case "ping":
		count := args.Count
		if count <= 0 {
			count = 3
		}
		return []string{"ping", "-c", strconv.Itoa(count), "-W", "3", target}, true
	case "iperf":
		secs := args.Seconds
		if secs <= 0 {
			secs = 5
		}
		return []string{"iperf3", "-c", target, "-t", strconv.Itoa(secs), "--json", "--connect-timeout", "5000"}, true
	case "custom":
		return []string{"sh", "-c", target}, true
	default:
		return nil, false
	}
}

func createWorkload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req workloadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad body"}`, 400)
		return
	}
	if req.NS == "" {
		req.NS = "aviary"
	}
	if req.Pod == "" {
		http.Error(w, `{"error":"pod required"}`, 400)
		return
	}
	if req.Target == "" {
		http.Error(w, `{"error":"target required"}`, 400)
		return
	}
	cmd, ok := resolveCmd(req.Kind, req.Target, req.Args)
	if !ok {
		http.Error(w, `{"error":"kind must be wget|ping|iperf|custom"}`, 400)
		return
	}
	// clamp interval to a sane range.
	if req.Interval < 2 {
		req.Interval = 2
	}
	if req.Interval > 3600 {
		req.Interval = 3600
	}

	workloadReg.mu.Lock()
	workloadReg.seq++
	id := fmt.Sprintf("wl-%d", workloadReg.seq)
	wl := &workload{
		ID:       id,
		Name:     req.Name,
		Pod:      req.Pod,
		NS:       req.NS,
		Kind:     req.Kind,
		Target:   req.Target,
		Interval: req.Interval,
		Running:  true,
		cmd:      cmd,
		stop:     make(chan struct{}),
	}
	workloadReg.m[id] = wl
	workloadReg.mu.Unlock()

	go wl.loop()

	w.WriteHeader(201)
	json.NewEncoder(w).Encode(wl.snapshot())
}

func deleteWorkload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, `{"error":"id query param required"}`, 400)
		return
	}
	workloadReg.mu.Lock()
	wl, found := workloadReg.m[id]
	if found {
		delete(workloadReg.m, id)
	}
	workloadReg.mu.Unlock()
	if !found {
		http.Error(w, `{"error":"not found"}`, 404)
		return
	}
	wl.halt()
	json.NewEncoder(w).Encode(map[string]string{"deleted": id})
}

// halt closes the stop channel exactly once so loop() exits.
func (wl *workload) halt() {
	wl.once.Do(func() { close(wl.stop) })
}

// loop runs the workload immediately, then on every tick, until stopped.
func (wl *workload) loop() {
	wl.runOnce()
	ticker := time.NewTicker(time.Duration(wl.Interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-wl.stop:
			workloadReg.mu.Lock()
			wl.Running = false
			workloadReg.mu.Unlock()
			return
		case <-ticker.C:
			wl.runOnce()
		}
	}
}

// runTimeout gives each run interval+30s, capped at a 60s floor so short
// intervals still allow a slow exec to finish.
func (wl *workload) runTimeout() time.Duration {
	d := time.Duration(wl.Interval+30) * time.Second
	if d < 60*time.Second {
		d = 60 * time.Second
	}
	return d
}

// runOnce execs the command in the pod once and records the result. It returns
// the snapshot of the workload after the run for callers that trigger it.
func (wl *workload) runOnce() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), wl.runTimeout())
	defer cancel()

	out, err := podExec(ctx, wl.NS, wl.Pod, wl.cmd)
	if len(out) > maxOutput {
		out = out[:maxOutput]
	}

	workloadReg.mu.Lock()
	wl.LastRunAt = time.Now().UTC().Format(time.RFC3339)
	wl.LastOk = err == nil
	wl.LastOutput = out
	wl.Runs++
	workloadReg.mu.Unlock()

	return wl.snapshot()
}

// workloadRunOnce handles POST /api/workloads/run?id=... — fire one immediate
// run and return its result.
func workloadRunOnce(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"POST only"}`, 405)
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, `{"error":"id query param required"}`, 400)
		return
	}
	workloadReg.mu.Lock()
	wl, found := workloadReg.m[id]
	workloadReg.mu.Unlock()
	if !found {
		http.Error(w, `{"error":"not found"}`, 404)
		return
	}
	json.NewEncoder(w).Encode(wl.runOnce())
}
