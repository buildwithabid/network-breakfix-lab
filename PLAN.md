# Plan

Status: **M0 in progress.** Plan approved 28 Sep 2026. Code for M0 written and unit-tested; waiting for the owner to run `sudo scripts/bootstrap.sh`, then the spike and the infra tests.

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
| R1 | Risk: containerlab may start `linux`-kind nodes privileged by default. | **Resolved from the v0.79.0 source:** `linux` nodes are privileged by default, but `privileged: false` per node is supported. The wrapper always sets it and the guard refuses `Privileged=true`. |
| R2 | Risk: FRR may need a capability outside the allowlist. | **Confirmed:** every FRR 10.7.1 daemon asks for `SYS_ADMIN` and exits without it (`lib/privs.c`). See B13. The M0 spike narrows the rest of the set. |
| B11 | The brief says "TypeScript everywhere". | The two root-side helpers (`breakfix-clab`, `docker-guard`) are Python using only the standard library + Debian's `python3-yaml`, run with `python3 -I`. That way no npm package, and nothing from a user-writable path, ever runs with root or Docker access. Everything else is TypeScript. |
| B12 | "Pin current stable": TypeScript 7.0 is current. | TypeScript **6.0.3**: typescript-eslint 8.70 supports TypeScript < 6.1 only. Revisit when typescript-eslint supports 7. |
| B13 | FRR needs `SYS_ADMIN` (R2). | Granted to routers only, and contained: Docker `userns-remap` (container root = unprivileged host UID), `no-new-privileges`, default seccomp + AppArmor never overridden, no network egress, vtysh-only access. Documented in docs/security.md. |
| B14 | containerlab has no `cap-drop` option, and its `.deb` makes the binary setuid root for a `clab_admins` group. | The guard's deploy socket rewrites every container create (`CapDrop=ALL` + the role's caps), and containerlab talks to Docker only through it. Bootstrap removes the setuid bit and empties `clab_admins`. |
| B15 | B6 (internet access) | **Resolved from the source:** with `network-mode: none` on every node and `mgmt.skip-when-unused: true`, containerlab creates no management network and does not edit `/etc/hosts`. Nodes have only lab links. No firewall rule needed; a test proves no outbound path. |

## Pinned versions (checked 28 Sep 2026; digests recorded in M0)

| What | Version |
|---|---|
| FRRouting image | `quay.io/frrouting/frr:10.7.1` pulled by digest `sha256:e995…`; image ID checked at every container create |
| Host image | `breakfix-host:0.1.0`, built from `alpine:3.24.2@sha256:294b…` + pinned `iproute2-minimal`, `iputils-ping`, `traceroute`, `tini` |
| containerlab | 0.79.0 (release `.deb`, sha256-checked) |
| Docker | Docker CE 29.8.1, containerd 2.3.6, buildx 0.37.1 (Docker's apt repo, key fingerprint checked) |
| Node / pnpm | Node 22.23.2, pnpm 12.6.0 (`packageManager` + corepack) |
| TypeScript | 6.0.3 (B12) |
| Dev tools | gitleaks 8.30.1, shellcheck 0.11.0 (sha256-checked, `scripts/dev-tools.sh`) |
| npm deps | exact versions, lockfile committed |

## Milestones

Each milestone ends with its tests green, docs updated and a commit.

### M0: Bootstrap
- [x] `scripts/bootstrap.sh`: idempotent, run as root. It does the following:
  - installs pinned Docker CE (userns-remap, `no-new-privileges`, `cgroup-parent: breakfix.slice`) and pinned containerlab (setuid removed);
  - creates the `breakfix` and `bfx-guard` users and the `breakfix.slice`;
  - installs `breakfix-clab` + the sudoers rule (whole config re-validated) and the `docker-guard` service;
  - pulls FRR by digest, builds `breakfix-host`, and records the image IDs;
  - ends with a verification summary.
- [x] `breakfix-clab` wrapper and `docker-guard` proxy (`infra/bfx_infra`), plus 40 unit tests (`pnpm test:helpers`): policy, proxy against a fake Docker, wrapper file handling.
- [x] pnpm workspace skeleton (`apps/server`, `apps/web`, `packages/scenario-kit`), TS strict, ESLint, Vitest (`unit` + `infra` projects).
- [x] `docs/SETUP.md` (fresh box, migration, uninstall), `docs/security.md`, `.env.example`, `.gitignore`, `IDEAS.md`, README.
- [x] `scripts/dev-tools.sh` (pinned gitleaks + shellcheck) and a gitleaks pre-push hook.
- [ ] Owner runs `sudo scripts/bootstrap.sh`.
- [ ] Spike: the FRR node runs unprivileged with the minimum caps under userns-remap; vtysh works through the guard; narrow the router cap set and update docs/security.md.
- [ ] Infra tests green (`pnpm test:infra`): host preparation, wrapper refusals, lab hardening, no internet.
- [ ] Public repo `buildwithabid/network-breakfix-lab` created and pushed (gitleaks clean).

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
