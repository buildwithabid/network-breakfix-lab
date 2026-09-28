# Security

A candidate gets a live router CLI in the browser. The design goal is that the worst a candidate can
do is break their own lab. Everything below has an automated test; the test file is named in each
section.

## Threat model

| Actor | Can reach | Must not reach |
|---|---|---|
| Candidate (browser) | vtysh on lab routers; a whitelisted command console on lab hosts | any shell, the server, other labs, the host, the internet |
| Server process (`breakfix`) | the guard's app socket, `sudo breakfix-clab` | the Docker socket, root, other users' files |
| Developer account | the same as the server | the Docker socket, root |

## Privilege separation

```
browser ──HTTPS/WS──> server (user breakfix: no root, not in the docker group)
                        ├─ sudo breakfix-clab deploy|destroy|list  ──> containerlab (root)
                        │     validates the topology, copies files,        │
                        │     writes a hardened topology                   │ DOCKER_HOST=deploy.sock
                        └─ docker-guard app.sock ─┐                        v
                                                  └──> docker-guard ──> dockerd (userns-remap)
```

**Why not the brief's "sudoers rule for the containerlab binary"?** containerlab runs as root and a
topology can bind-mount any host path (`/:/host`), run commands, or start privileged containers. Anyone
allowed to run containerlab with a file they wrote is root. So sudo allows only
`/usr/local/sbin/breakfix-clab`, which:

- accepts `deploy <dir>`, `destroy <bfx-name>`, `list`, nothing else;
- validates the topology against an allowlist (`infra/bfx_infra/policy.py`): pinned images only, node
  keys limited to `kind/image/binds/exec/cap-add`, binds only to `/etc/frr/{frr.conf,daemons,vtysh.conf}`,
  `exec` only on hosts and only `ip addr/link/route add` forms, capabilities within a per-role maximum;
- copies only regular files (opened with `O_NOFOLLOW`, size-capped) into
  `/var/lib/breakfix-clab/labs/<lab>/`, so containerlab never reads a path the caller controls;
- writes the topology itself: `network-mode: none`, `privileged: false`, `restart-policy: no`,
  memory/CPU limits, router sysctls;
- reads every container back after deploy and destroys the lab if any hardening is missing;
- is Python using only the standard library and Debian's `python3-yaml`, run with `python3 -I`, so no
  npm or PyPI package ever runs as root.

The containerlab `.deb` makes its binary setuid root for members of `clab_admins`. Bootstrap removes
the setuid bit and empties that group.

**Why a Docker proxy?** Access to `/run/docker.sock` is root-equivalent, so "the server runs as a
non-root user" means nothing if that user can reach the socket. `docker-guard` (`infra/bfx_infra/guard.py`)
runs as `bfx-guard` under a hardened systemd unit and exposes two sockets:

- `app.sock` (group `breakfix`): list/inspect `bfx-*` lab containers, create execs that pass the exec
  policy, and start/resize/inspect only execs it created. Anything else gets 403, and non-lab
  containers look absent (404).
- `deploy.sock` (owner only; used by containerlab through the wrapper): every container create is
  validated and rewritten: `CapDrop=["ALL"]`, `CapAdd` within the role maximum, no privileged, no
  devices/mounts/ports/host namespaces, `NetworkMode=none`, binds only inside the lab directory,
  `no-new-privileges`, memory/CPU/PID limits, and the image must resolve to the exact image ID pinned
  at bootstrap. This is a second check behind the wrapper, and it is also how capabilities get dropped
  at all: containerlab has no `cap-drop` option.

Tests: `infra/tests/test_policy.py`, `infra/tests/test_guard.py`, `infra/tests/test_clab.py`,
`tests/infra/host.test.ts`, `tests/infra/wrapper.test.ts`.

## Inside a lab container

| Control | How | Test |
|---|---|---|
| Not privileged | wrapper sets `privileged: false`; guard refuses `Privileged=true` | `tests/infra/lab.test.ts` |
| Minimal capabilities | guard sets `CapDrop=ALL`, adds back the role's set (below) | `lab.test.ts` |
| Root is not root | Docker `userns-remap`: container root maps to an unprivileged host UID | `lab.test.ts` |
| No new privileges | `no-new-privileges` (daemon default and per container) | `lab.test.ts` |
| Default seccomp and AppArmor profiles | never overridden; guard replaces any `SecurityOpt` | `test_policy.py` |
| No internet | no management interface at all (`network-mode: none`); only lab links exist | `lab.test.ts` |
| Resource limits | per node: memory, CPU quota, PIDs; all labs together: `breakfix.slice` | `lab.test.ts` |

### Capabilities

Docker's default set is dropped entirely. What is added back:

| Capability | Role | Why |
|---|---|---|
| `NET_ADMIN` | router, host | zebra programs addresses and routes; hosts get their address at deploy |
| `NET_RAW` | router, host | OSPF uses raw IP sockets; ping and traceroute |
| `NET_BIND_SERVICE` | router | bgpd listens on port 179 |
| `SYS_ADMIN` | router | every FRR daemon asks for it at start-up and exits if it is missing (`lib/privs.c`, `zebra_capabilities_t _caps_p[]`); with userns-remap it only has meaning inside the container's own namespaces |
| `SETUID`, `SETGID` | router | FRR daemons drop from root to the `frr` user |
| `CHOWN`, `DAC_OVERRIDE`, `FOWNER` | router | the FRR entrypoint chowns `/etc/frr` and the run directories |
| `KILL` | router | watchfrr signals the daemons it supervises |

The router set is the upper bound checked by the guard. The M0 spike narrows it to what FRR 10.7.1
actually needs, and this table is updated with the result.

## Candidate access

- **Routers:** the only interactive exec the guard allows is `vtysh`, always with `VTYSH_PAGER=cat`,
  because vtysh's `terminal paginate` pipes output through `more`, whose `!` runs a shell.
  Non-interactive execs are limited to `vtysh -c "show …"` (no pipes, no `;`, no newlines).
- **Hosts:** no TTY. Only `ping` (count ≤ 10), `traceroute`, `ip addr|route|link|neigh show` and
  `ip route get`, with every argument checked. The server validates first and the guard checks again.

Shell-escape tests inside an interactive vtysh (`start-shell`, the pager) are added in M3.

## Host protection

This project currently shares a host with other services. `breakfix.slice` caps all lab containers
together (3 GB RAM, 2 CPUs, 4096 tasks), Docker is configured so every container lands in that slice,
and the server never has access outside `/srv/breakfix`, `/var/lib/breakfix` and the two sockets.
