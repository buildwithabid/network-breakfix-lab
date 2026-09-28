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
  keys limited to `kind/image/binds/exec/cap-add`, one bind per router and only of its config directory to `/etc/frr`,
  `exec` only on hosts and only `ip addr/link/route add` forms, capabilities within a per-role maximum;
- copies only `frr.conf`, `daemons` and `vtysh.conf`, as regular files (opened with `O_NOFOLLOW`, size-capped, no symlinked directories), into
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

| Capability | Role | Why (measured on FRR 10.7.1: OSPF + BGP between two routers, then `write memory`) |
|---|---|---|
| `NET_ADMIN` | router, host | without it zebra, mgmtd, bgpd and ospfd die at start-up; hosts need it to get their address at deploy |
| `NET_RAW` | router, host | without it zebra, mgmtd, bgpd and ospfd die (OSPF uses raw IP sockets); ping and traceroute on hosts |
| `NET_BIND_SERVICE` | router | without it mgmtd, bgpd and ospfd die (bgpd listens on port 179) |
| `SYS_ADMIN` | router | every FRR daemon asks for it at start-up and exits if it is missing (`lib/privs.c`); with userns-remap it only has meaning inside the container's own namespaces |
| `SETUID`, `SETGID` | router | without them every daemon dies: FRR drops from root to the `frr` user |
| `DAC_OVERRIDE` | router | without it the container stops during start-up |
| `CHOWN` | router | without it `write memory` fails ("can't chown configuration file") |

Measured as not needed and therefore not granted: `FOWNER`, `KILL`, and the rest of Docker's
default set (`MKNOD`, `SYS_CHROOT`, `AUDIT_WRITE`, `SETFCAP`, `SETPCAP`, `FSETID`). The spike that
measured this deployed the two-router lab once per capability with that capability removed.

A router's whole `/etc/frr` is one directory in the lab, owned by the container's (remapped) root, and
holding only `frr.conf`, `daemons` and optionally `vtysh.conf`. Mounting the directory rather than
single files lets `write memory` rename and save its files like on a real router.

## Candidate access

- **Routers:** the only interactive exec the guard allows is `vtysh`, always with `VTYSH_PAGER=cat`,
  because vtysh's `terminal paginate` pipes output through `more`, whose `!` runs a shell.
  Non-interactive execs are limited to `vtysh -c "show …"` (no pipes, no `;`, no newlines).
- **Hosts:** no TTY. Only `ping` (count ≤ 10), `traceroute`, `ip addr|route|link|neigh show` and
  `ip route get`, with every argument checked. The server validates first and the guard checks again.

Verified inside a live router terminal (`tests/infra/server.test.ts`): `start-shell` (and its `bash`
form) is not compiled into this vtysh ("% Unknown command"); `terminal paginate` + `show running-config`
+ `!sh` starts no pager and no shell; `ssh`, `telnet` and shell syntax lead nowhere; a shell marker
(`echo PWNED-$((6*7))`) never evaluates. The same file checks the host console refuses `sh`, `;`, `$(…)`,
`ip addr add`, `cat /etc/shadow`, and that a lab host cannot ping `1.1.1.1`.

The host console parser (`apps/server/src/terminals/host-commands.ts`) is stricter than the guard; a
unit test runs every command form the console can produce through the guard's Python policy, so the
two can never drift apart.

## Sessions and the web server

| Control | How | Test |
|---|---|---|
| Unguessable test links | 256-bit random token (`/t/<43 chars>`); only its SHA-256 is stored; single use (claimed in the same transaction that creates the session); optional expiry | `apps/server/src/sessions/service.test.ts` |
| Session cookie | `<id>.<256-bit secret>`, HttpOnly, SameSite=Strict, Secure behind HTTPS; the secret is stored hashed and compared in constant time | `http/app.test.ts` |
| Brute force | test-link redemption rate-limited per IP (`START_RATE_LIMIT`, default 10/min) | `http/app.test.ts` |
| WebSocket | cookie required; `Origin` must match `PUBLIC_URL`; every message validated (zod), 64 KB max, 200 msg/s; anything else closes the socket | `http/app.test.ts` |
| Logs | pino redacts cookies and auth headers; `/t/<token>` is scrubbed from URLs and from message text | `http/app.test.ts` |
| Headers | CSP `default-src 'self'`, `frame-ancestors 'none'`, nosniff, `Referrer-Policy: no-referrer` (a token in the URL never leaks via Referer) | `http/app.test.ts` |
| Optional basic auth | whole site, constant-time compare, for private review deployments | `http/app.test.ts` |
| Not root | the server exits at start-up if its uid is 0 | `security/root.test.ts` |
| Polling is invisible | the live diagram's `show … json` polling runs through a separate exec, never a candidate terminal, so it never enters the command log | `service.test.ts`, `server.test.ts` |
| Leftover labs | the reaper destroys session labs whose session is over, unknown, or 5 min past its deadline, and test labs older than 2 h | `service.test.ts`, `tests/infra/reaper.test.ts` |

## Host protection

This project currently shares a host with other services. `breakfix.slice` caps all lab containers
together (3 GB RAM, 2 CPUs, 4096 tasks), Docker is configured so every container lands in that slice,
and the server never has access outside `/srv/breakfix`, `/var/lib/breakfix` and the two sockets.
