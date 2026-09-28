# Plan

Status: **plan written, waiting for owner approval. No code yet.**

## Decisions and brief issues

| # | Issue in the brief | Decision |
|---|---|---|
| B1 | The brief asks for a dedicated box. | Owner decision (28 Sep 2026): build and run on the current host for personal use, migrate later. `breakfix.slice` caps all lab containers together (starting values: 3 GB RAM, 2 CPUs, 4096 tasks) so labs can never starve other services. `docs/SETUP.md` includes the migration steps. |
| B2 | Visual layer (owner correction, 28 Sep) | The live diagram is the main screen. Link up/down, OSPF neighbour state and BGP session state come from real `vtysh ... json` output polled by the server. Ping/traceroute paths are animated from the routers' real routing tables, including where a packet dies. Protocol status is shown in tests too (owner decision). |
| B3 | "Server runs as non-root" + dockerode: access to the Docker socket is root. | `docker-guard`: a small root-run proxy in this repo. It exposes a unix socket to the `breakfix` group and allows only list/inspect of `bfx-*` containers and exec of allowlisted argv. Everything else gets 403. dockerode points at it. |
| B4 | A sudoers rule "limited to the containerlab binary" is still root: any topology can bind-mount `/`. | sudoers allows only `/usr/local/sbin/breakfix-clab`. It is root-owned Python using the stdlib and Debian's `python3-yaml`, and runs no repo code. It accepts `deploy/destroy/list` + a `bfx-` lab name, copies the rendered lab into `/run/breakfix` (no symlinks), and rejects anything outside the allowlist (pinned images only, no binds except the node's own config files, no `exec`, no ports, no privileged, caps ⊆ allowlist). It then injects caps, limits and the network settings and runs containerlab. Tests feed it malicious topologies. |
| B5 | vtysh `start-shell` is not the only escape: `terminal paginate` sends output through `more`, and `more` can run `!sh`. | Every vtysh exec gets `VTYSH_PAGER=cat`. Tests cover `start-shell`, the pager and other escapes, and prove no shell process ever spawns. |
| B6 | containerlab's management network has internet access by default. | Preferred: nodes with no management interface at all (`network-mode: none`), since we reach nodes through `docker exec`, not SSH. Fallback: a DOCKER-USER drop rule for the lab management subnet, set by bootstrap. A test proves no outbound access either way. **Verify in M0.** |
| B7 | The agent has no passwordless sudo on this host. | The owner runs `sudo scripts/bootstrap.sh` once in M0, and again only when a root-owned piece changes (one pasted line each time). All other work runs unprivileged through B3/B4, so the security design is exercised from day one. |
| B8 | HTTPS needs a domain, which arrives later. | Until then, the M4 review runs on plain HTTP with basic auth on port 8480: fine for personal review, not for real candidates. HTTPS (Caddy + Let's Encrypt) is added when the domain arrives. |
| B9 | The brief's scenario format has no way to prove that a workaround fails. | Optional `scenarios/<id>/workaround/`: a known shortcut fix (e.g. a static route instead of fixing OSPF). The self-test deploys it and requires at least one objective to fail. |
| B10 | "Destroyed on submit or timeout" | On timeout the session is auto-submitted (configs captured, checks run), then the lab is destroyed, so a timed-out candidate still gets results. |
| R1 | Risk: containerlab may start `linux`-kind nodes privileged by default. | M0 spike checks `HostConfig.Privileged` on a deployed node. If it cannot be turned off, stop and bring options to the owner. |
| R2 | Risk: FRR may need a capability outside the allowlist. | M0 spike finds the minimum set. Anything beyond `NET_ADMIN, NET_RAW, NET_BIND_SERVICE, SETUID, SETGID, CHOWN, DAC_OVERRIDE, FOWNER, KILL` gets raised before it is used. |

## Pinned versions (checked 28 Sep 2026; digests recorded in M0)

| What | Version |
|---|---|
| FRRouting image | `quay.io/frrouting/frr:10.7.1` (latest stable) |
| Host image | `breakfix-host`, built locally from `alpine:3.24.2` + pinned `iproute2`, `iputils`, `traceroute` |
| containerlab | 0.79.0 (Debian package, version-pinned) |
| Docker | Docker CE from Docker's apt repo, exact version pinned in `bootstrap.sh` |
| Node / pnpm | Node 22.23.x (already installed), pnpm pinned via `packageManager` + corepack |
| npm deps | exact versions, lockfile committed |

## Milestones

Each milestone ends with its tests green, docs updated and a commit.

### M0: Bootstrap
- [ ] `scripts/bootstrap.sh` (idempotent, run as root). It installs pinned Docker CE and containerlab and `python3-yaml`. It creates the `breakfix` user and group, `/srv/breakfix`, `/var/lib/breakfix` and `breakfix.slice`, with Docker's `cgroup-parent` pointed at it and log size limits set. It installs `breakfix-clab` + a sudoers rule (checked with `visudo -c`) and the `docker-guard` systemd service, pulls the pinned images by digest and builds `breakfix-host`. It checks Node 22 + pnpm, and ends by printing a verification summary.
- [ ] Spike: an FRR node deployed through `breakfix-clab` runs with no privileged flag and the minimum caps, and `vtysh -c 'show version'` works through `docker-guard`. Resolves R1, R2 and B6. Results go in `docs/security.md`.
- [ ] pnpm workspace skeleton (`apps/server`, `apps/web`, `packages/scenario-kit`), TS strict, ESLint, Vitest wired.
- [ ] `docs/SETUP.md` (fresh box + migration), `.env.example`, `.gitignore`, `IDEAS.md`, README stub.
- [ ] Infra tests: an FRR container runs; the agent user is not in the `docker` group; `breakfix-clab` and `docker-guard` reject out-of-policy requests.
- [ ] gitleaks (pinned) pre-push hook. Public repo `buildwithabid/network-breakfix-lab` created and pushed.

### M1: Scenario kit + scenario 1 end to end (CLI)
- [ ] zod schema for `scenario.yaml` (id, title, difficulty, time limit, ticket, objectives, hints). The loader checks that every node in the topology has baseline and fault configs.
- [ ] Topology renderer: scenario + variant (baseline | fault | workaround) → lab dir with a unique `bfx-` lab name.
- [ ] Checker engine, pure and unit-tested against JSON fixtures captured from FRR 10.7.1. Rule types: `reachability` (host → IP), `route-present` (router, prefix, required protocol), `ospf-neighbor` (state), `bgp-session` (state), `prefix-received`.
- [ ] Lab runner in scenario-kit: deploy, wait-ready, exec, destroy, always cleaned up (also on Ctrl-C and on failure).
- [ ] `pnpm scenario:test <id>` and `--all`: baseline → all pass; fault → at least one fails; workaround (if present) → at least one fails.
- [ ] Scenario 01: wrong IP or mask on a router interface. Integration test runs its self-test.

### M2: Scenarios 2–5
- [ ] 02 missing static/default route
- [ ] 03 OSPF adjacency not forming (area or hello/dead mismatch); workaround = static route must fail
- [ ] 04 BGP session down (wrong neighbour address or remote-as)
- [ ] 05 prefix-list silently filtering a route that should be advertised; workaround = removing the policy entirely must fail
- [ ] `pnpm scenario:test --all` green

### M3: Server
- [ ] SQLite schema + migrations: tests, sessions, events (per-device command log), config snapshots, objective results. It also exports a versioned "assessment bundle" JSON per session so an AI assessment step can be added later (no AI now).
- [ ] Session API: start from a token link, state, submit. Tokens are 256-bit, stored as SHA-256. Rate limits on session creation.
- [ ] Lab lifecycle: queue + concurrency cap (default 5); per-node CPU, memory and PID limits; timeout → auto-submit → destroy.
- [ ] Reaper: on start and every minute, destroy `bfx-` labs that have expired or have no session record.
- [ ] WebSocket terminals: router → interactive `vtysh` TTY through `docker-guard`; host → restricted console (whitelisted commands, validated args, argv exec).
- [ ] Command capture: a server-side headless terminal (`@xterm/headless`) mirrors each router TTY. On Enter it records the line as displayed, so tab completion, history and editing are captured exactly, with timestamps.
- [ ] Config capture: `show running-config` per router at start and at submit; unified diff stored.
- [ ] Live state for the diagram: a poller (every ~3 s per active lab) reads interface, OSPF neighbour and BGP summary JSON and pushes changes over the session WebSocket. Excluded from the command log.
- [ ] Packet path: for each candidate ping/traceroute, compute the forward and return path hop by hop from the routers' real routing tables, and emit a path event that marks where it stops.
- [ ] Security tests for rules 1–7 in CLAUDE.md, plus: `breakfix` cannot read the owner's home; lab containers sit inside `breakfix.slice`; the limits read back correctly from `docker inspect`.

### M4: Web UI → then STOP
- [ ] Test landing page (`/t/<token>`): scenario title, rules, start; queue position while waiting.
- [ ] Workspace: ticket + countdown; the live topology diagram is the main screen (link and protocol state colours, legend, packet animation); click a node to open its terminal tab; host console tabs; submit with confirmation.
- [ ] Results: pass/fail per objective, time taken, per-device command log with timestamps, config diff per router.
- [ ] Desktop-first, readable at 390 px wide.
- [ ] Playwright e2e on a real lab: start scenario 01, fix it in the terminal, submit, see all objectives pass. Visual test: a broken link turns red on the diagram.
- [ ] Deploy: systemd service `breakfix-server` as user `breakfix` on :8480 with basic auth (from `.env`).
- [ ] **STOP**: send the owner the URL, the basic-auth login and Playwright screenshots (desktop + mobile), then wait for feedback.

### M5: Admin (after owner feedback)
- [ ] Admin login (password from env, hashed compare, rate-limited).
- [ ] Create test links per scenario; list sessions and results; open any result page.

### M6: Portfolio polish
- [ ] README: Mermaid architecture diagram, screenshots, demo GIF (Playwright video → ffmpeg).
- [ ] `docs/adr/`: why FRR, why containerlab, why vtysh-only, why SQLite, and the privilege-separation design (B3/B4).
- [ ] GitHub Actions: unit tests + scenario self-tests (runner installs pinned Docker/containerlab through `bootstrap.sh`).
- [ ] `/metrics` (Prometheus): active sessions, queue length, deploy time, reaper actions, check results.
- [ ] HTTPS via Caddy once the domain arrives (B8).
