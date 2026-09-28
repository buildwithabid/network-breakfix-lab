# Writing a scenario

A scenario is one folder in `scenarios/`, named `NN-short-name`. It describes a small network in a
working state, the fault to inject, and the objectives the checker uses to decide whether the
candidate fixed it the intended way.

```
scenarios/01-wrong-ip-mask/
├── scenario.yaml        ticket, time limit, objectives, hints
├── topology.clab.yml    nodes and links (containerlab format)
├── baseline/<router>/   working config of every router
├── fault/<router>/      only the files that differ from baseline
└── workaround/<router>/ optional: a tempting shortcut that the checks must reject
```

## topology.clab.yml

A plain containerlab topology with a restricted set of keys:

- every node is `kind: linux` with image `quay.io/frrouting/frr:10.7.1` (a router) or
  `breakfix-host:0.1.0` (a host);
- hosts are configured with `exec:` lines, limited to `ip link set ethN up`,
  `ip addr add <cidr> dev ethN` and `ip route add <default|cidr> via <ip> [dev ethN]`;
- routers are configured only by their `frr.conf`, never by `exec`;
- no `binds` or `cap-add`: the renderer adds the `/etc/frr` bind and the measured capability set;
- interfaces are `eth1`–`eth32` (there is no management interface; `eth0` does not exist).

`name` is replaced by a unique `bfx-…` lab name at deploy time.

## Configs

`baseline/<router>/frr.conf` is required for every router. A router may also have its own `daemons`
file; otherwise the kit's default runs zebra, mgmtd, staticd, ospfd and bgpd. `vtysh.conf` always
comes from the kit.

`fault/` holds only the files that change. It is laid over baseline, and `workaround/` is laid over
fault. The loader refuses a fault that changes nothing and a workaround that changes nothing.

## Objectives

Each objective is one rule, checked with one read-only command on one node:

| Rule | Fields | Passes when |
|---|---|---|
| `reachability` | `from` (a host), `to`, `count` (default 3) | `ping -c count -W 1 to` gets at least one reply |
| `route-present` | `router`, `prefix`, `protocol`, optional `nexthop` | the exact prefix is in `show ip route json`, from that protocol, selected and installed (and via `nexthop`) |
| `ospf-neighbor` | `router`, `neighbor` (router ID), `state` (default `Full`) | the neighbour is in that state |
| `bgp-session` | `router`, `peer` | the session is `Established` |
| `prefix-received` | `router`, `peer`, `prefix` | a valid path for the prefix from that peer is in the BGP table |

`protocol` is one of `connected`, `static`, `ospf`, `bgp`, `kernel`, `local`.

Add `negate: true` to an objective that must **not** hold, e.g. a prefix that has to stay filtered
(scenario 05). If the node can't be read at all (a crashed daemon, a failed command), a negated
objective still fails: an unreadable router never counts as "the prefix is absent".

**Check the intended fix, not just reachability.** Pair the reachability objectives with at least
one objective that only the real fix satisfies: the OSPF adjacency, the corrected subnet, the BGP
session, the prefix learned from the right peer. For example, a static route that papers over broken
OSPF restores pings, but fails `route-present … protocol: ospf`.

| Scenario | Fault | Workaround the checks reject |
|---|---|---|
| 01-wrong-ip-mask | r2's transit interface is /31 instead of /30 | a host route to the next hop |
| 02-missing-default-route | r1 has no default route | one static route per destination |
| 03-ospf-timer-mismatch | hello/dead timers differ on r2–r3 | static routes on all three routers |
| 04-bgp-wrong-remote-as | r1 expects AS 65002, r2 is AS 65020 | static routes instead of BGP |
| 05-prefix-list-filter | the outbound prefix-list lacks the new LAN | removing the filter (leaks the management address) |

## Self-test

```bash
pnpm scenario:test 01-wrong-ip-mask     # or --all
```

Each variant is deployed as a real lab, in parallel:

| Variant | Must |
|---|---|
| baseline | reach all-pass (polled while the network converges, up to 2 minutes) |
| fault | after 20 s of settling, fail at least one objective in two checks 5 s apart |
| workaround | pass every `reachability` objective, yet still fail at least one other objective in two checks |

The workaround rule is what proves the objectives check the intended fix. Every scenario should
ship one.
