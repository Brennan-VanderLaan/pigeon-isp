# Uplink — routing the aviary to the world

Aviary pods have no normal network — their only NIC is a conveyor belt. The
**uplink** gives them a way out: a host dual-homed on the pigeon network and
the real network, doing routing + NAT. So a pod can `apt-get update` — but
only if YOU carry its packets there.

```
aviary pod ──eth(default route 10.99.0.1)──► loft ──(you route the frame)──►
  uplink /port ──strip eth──► TUN ──► kernel ip_forward + MASQUERADE ──►
    pod's real interface ──► the internet
return ──► conntrack un-NAT ──► route to TUN ──► uplink wraps eth (ARP) ──►
  loft ──(you route it back)──► aviary pod's landing
```

## How it works

`bridge/cmd/uplink` registers as host **10.99.0.1** on the loft (via the
`/port` API, like perch/WireGuard), answers ARP for itself, and bridges to a
TUN. The kernel does the real work: `ip_forward` + an `iptables MASQUERADE`
on the pod's WAN interface NAT the pigeon net (10.99.0.0/16) out to the world.
The uplink pod lives in `pigeon-system` (infra net), which already has
internet via the node's NAT — so it just adds a second hop of NAT for aviary
traffic.

`pigeon-cni` gives every aviary pod a default route via 10.99.0.1. That route
is **inert** until two things are true: the uplink is deployed, and YOU have
built a belt path carrying the pod's egress frames to the uplink's landing
(and replies back to the pod). No path → off-net traffic goes nowhere, which
is correct.

## The named gateway: DNS and the console, over the tunnel

The uplink's TUN owns `10.99.0.1/16`, so any service bound to 10.99.0.1 is
delivered to locally (and replies ride the same return path). The uplink runs
two more services there, so the one gateway you route to gives you the whole
internet experience:

- **DNS resolver** on `10.99.0.1:53`. Answers `*.pigeon.isp` from the loft
  `/hosts` registry — `alice.pigeon.isp` → alice's aviary IP — plus gateway
  aliases (`ui`/`gateway`/`router`/`pigeon` → 10.99.0.1). Everything else is
  forwarded to an upstream resolver (`1.1.1.1` by default). DNS only resolves
  if you carried the query to the uplink, so even name lookup is routed.
- **UI reverse-proxy** on `10.99.0.1:80` → Traefik (Host rewritten to
  `pigeon.localhost`). A joined VPN device can open **http://ui.pigeon.isp**
  and reach the management console — but only over the tunnel, so it's gated
  by VPN membership.

This is what makes **full-tunnel WireGuard** usable: a phone with
`AllowedIPs = 0.0.0.0/0` and `DNS = 10.99.0.1` sends *all* its traffic —
YouTube, apps, DNS — into the tunnel, and it only loads if you route those
frames to the uplink. Load a webpage on your phone and watch it leave as
pigeons. See [edge.md](edge.md) for the client side.

## Build your own firewall

The egress path runs through your factory, so it runs through your machines.
Want to block a host from the internet? Don't wire its egress. Allow only DNS
and HTTP? Filter by `l4.dst` and only route 53/80/443 toward the uplink. Rate
limit a noisy pod? A meter on its egress lane. Log/seq every outbound flow?
A MIDI block. The routing IS the firewall — and you can watch every packet
leave as a pigeon.

## Try it

1. `kubectl -n pigeon-system get deploy uplink` — it bridges as `uplink`
   (10.99.0.1) on the loft (verified: registers, finds the WAN, sets up
   MASQUERADE).
2. Spawn/recreate an aviary host so it picks up the default route
   (`ip route` inside it shows `default via 10.99.0.1`).
3. Build belts: the host's roost → (your firewall machines) → uplink's
   landing, and uplink's roost → back to the host's landing. Attach a router
   (the game in `?autoroute=1`, or `tools/autoroute.mjs`).
4. `kubectl -n aviary exec <host> -- wget -O- http://example.com` — the
   request rides out as pigeons, the uplink NATs it, the reply rides back.
