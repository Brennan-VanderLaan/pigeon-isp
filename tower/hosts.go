// hosts — runtime aviary occupants. The aviary CNI is each pod's ONLY network,
// so spawning arbitrary containers here is safe-ish: nothing they do reaches the
// wider world unless a player is physically routing their frames. That makes the
// aviary a natural sandbox for CTF boxes, iperf rigs, ping targets, whatever.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DNS-1123 label: lowercase alnum and '-', must start/end alnum, <=63 chars.
// k8s would reject a bad name anyway, but a 400 here is friendlier than a 500.
var dns1123 = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

type hostReq struct {
	Name       string   `json:"name"`
	Template   string   `json:"template"` // ping|nginx|iperf-server|iperf-client|custom
	Image      string   `json:"image"`    // custom only
	Cmd        []string `json:"cmd"`      // custom only (optional)
	TTLSeconds int64    `json:"ttlSeconds"`
}

// hosts routes /api/hosts by method: GET lists, POST spawns, DELETE removes.
// (withJSON is GET-shaped; spawning needs the request body, so this one is raw.)
func hosts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		withJSON(listHosts)(w, r)
	case http.MethodPost:
		createHost(w, r)
	case http.MethodDelete:
		deleteHost(w, r)
	default:
		http.Error(w, `{"error":"GET|POST|DELETE only"}`, 405)
	}
}

func listHosts(ctx context.Context) (any, error) {
	pods, err := clientset.CoreV1().Pods("aviary").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, p := range pods.Items {
		image := ""
		if len(p.Spec.Containers) > 0 {
			image = p.Spec.Containers[0].Image
		}
		out = append(out, map[string]any{
			"name":   p.Name,
			"image":  image,
			"node":   p.Spec.NodeName,
			"phase":  string(p.Status.Phase),
			"podIP":  p.Status.PodIP,
			"labels": p.Labels,
		})
	}
	return map[string]any{"hosts": out}, nil
}

// template fills in image/command for the canned hosts. custom is handled by
// the caller since it needs the request-supplied image/cmd.
func template(name string) (image string, command, args []string, ok bool) {
	switch name {
	case "ping":
		// idle busybox — sit ready for `exec ping` against another aviary IP.
		return "busybox:1.36", []string{"sh", "-c", "sleep 2147483647"}, nil, true
	case "nginx":
		return "nginx:1.27-alpine", nil, nil, true
	case "iperf-server":
		return "networkstatic/iperf3", nil, []string{"-s"}, true
	case "iperf-client":
		// idle — exec iperf3 -c <ip> when a run is triggered.
		return "networkstatic/iperf3", []string{"sh", "-c", "sleep 2147483647"}, nil, true
	default:
		return "", nil, nil, false
	}
}

func createHost(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req hostReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad body"}`, 400)
		return
	}
	if !dns1123.MatchString(req.Name) || len(req.Name) > 63 {
		http.Error(w, `{"error":"name must be a DNS-1123 label"}`, 400)
		return
	}

	var image string
	var command, args []string
	if req.Template == "custom" {
		if req.Image == "" {
			http.Error(w, `{"error":"custom template needs image"}`, 400)
			return
		}
		image, command = req.Image, req.Cmd
	} else {
		var ok bool
		image, command, args, ok = template(req.Template)
		if !ok {
			http.Error(w, `{"error":"template must be ping|nginx|iperf-server|iperf-client|custom"}`, 400)
			return
		}
	}

	c := corev1.Container{
		Name:    "host",
		Image:   image,
		Command: command,
		Args:    args,
		// NET_RAW so the occupant can craft/recv raw frames — ping, scans, etc.
		SecurityContext: &corev1.SecurityContext{
			Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_RAW"}},
		},
	}
	grace := int64(1) // these are cattle; don't wait 30s to reap them.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: "aviary",
			Labels: map[string]string{
				"app":         "pigeon-host",
				"pigeon-host": req.Name,
			},
		},
		Spec: corev1.PodSpec{
			TerminationGracePeriodSeconds: &grace,
			Containers:                    []corev1.Container{c},
			// Cluster DNS (10.96.0.10) is unreachable on the pigeon network,
			// so apt/wget would hang resolving before sending a packet. Point
			// at public resolvers instead — those queries become real frames
			// that route out through the uplink gateway you build.
			DNSPolicy: corev1.DNSNone,
			DNSConfig: &corev1.PodDNSConfig{
				Nameservers: []string{"1.1.1.1", "8.8.8.8"},
			},
		},
	}
	if req.TTLSeconds > 0 {
		// self-destruct: k8s marks the pod Failed once the deadline passes.
		pod.Spec.ActiveDeadlineSeconds = &req.TTLSeconds
	}

	created, err := clientset.CoreV1().Pods("aviary").Create(r.Context(), pod, metav1.CreateOptions{})
	if err != nil {
		if errors.IsAlreadyExists(err) {
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("host %q already exists", req.Name)})
			return
		}
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(201)
	json.NewEncoder(w).Encode(map[string]any{
		"name":  created.Name,
		"image": image,
		"phase": string(created.Status.Phase),
	})
}

func deleteHost(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, `{"error":"name query param required"}`, 400)
		return
	}
	err := clientset.CoreV1().Pods("aviary").Delete(r.Context(), name, metav1.DeleteOptions{})
	if err != nil {
		if errors.IsNotFound(err) {
			http.Error(w, `{"error":"not found"}`, 404)
			return
		}
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"deleted": name})
}
