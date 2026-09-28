# Plan

Status: **M4 done (28 Sep 2026). STOPPED for owner feedback** (brief: M5 starts only after it). Review deployment: this host, port 8480, basic auth.

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
| R2 | Risk: FRR may need a capability outside the allowlist. | **Confirmed:** every FRR 10.7.1 daemon asks for `SYS_ADMIN` and exits without it (`lib/privs.c`). See B13. The spike measured the full set: 8 caps (docs/security.md). |
| B11 | The brief says "TypeScript everywhere". | The two root-side helpers (`breakfix-clab`, `docker-guard`) are Python using only the standard library + Debian's `python3-yaml`, run with `python3 -I`. That way no npm package, and nothing from a user-writable path, ever runs with root or Docker access. Everything else is TypeScript. |
| B12 | "Pin current stable": TypeScript 7.0 is current. | TypeScript **6.0.3**: typescript-eslint 8.70 supports TypeScript < 6.1 only. Revisit when typescript-eslint supports 7. |
| B13 | FRR needs `SYS_ADMIN` (R2). | Granted to routers only, and contained: Docker `userns-remap` (container root = unprivileged host UID), `no-new-privileges`, default seccomp + AppArmor never overridden, no network egress, vtysh-only access. Documented in docs/security.md. |
| B14 | containerlab has no `cap-drop` option, and its `.deb` makes the binary setuid root for a `clab_admins` group. | The guard's deploy socket rewrites every container create (`CapDrop=ALL` + the role's caps), and containerlab talks to Docker only through it. Bootstrap removes the setuid bit and empties `clab_admins`. |
| B16 | Spike finding: binding `frr.conf` as a single file makes `write memory` print "Error renaming … Resource busy". | Each router's whole `/etc/frr` is one lab directory (owned by the container's remapped root) holding only `frr.conf`, `daemons`, `vtysh.conf`. `write memory` saves cleanly; a test checks it. |
| B17 | The brief says baseline/ holds "working configs for every node". | Routers only. Hosts are configured by allowlisted `exec` lines in `topology.clab.yml` (address, default route), which are the same in every variant. The brief's five faults are all router faults. |
| B18 | Self-test semantics for B9's workaround | A workaround must restore every `reachability` objective **and** still fail another one, in two checks 5 s apart. "At least one fails" alone would also pass a workaround fixture that doesn't work. |
| B19 | `route-present (router, prefix, required protocol)` | An optional `nexthop` was added. Scenario 01 needs it to tell "r2 routes back via r1" from a route that merely exists. |
| B20 | Scenario 05's shortcut is deleting the filter, and none of the brief's five rule types can express "must not be received". | Objectives take an optional `negate: true`. An unreadable node (crashed daemon, failed probe) never passes a negated objective. |
| B21 | Test links are needed from M3 on, but the admin UI is M5. | `pnpm admin link <scenario>` prints a link (same DB and config as the server). M5 adds the UI on top of the same service call. |
| B22 | Hints | Candidates open hints one at a time; each opening is logged in the timeline (`hint N`), so the assessment knows. |
| B23 | Packet-path animation | Drawn from the routers' live routing tables and interface state (longest match, next hop must answer on the link, interfaces up), forward and return path. It is a model of forwarding; the ping's own result stays the truth shown in the console. |
| B24 | Found by the M4 e2e run next to the live server: the production reaper destroyed the e2e server's lab (no session in *its* database). | `INSTANCE_ID` per server; session labs are `bfx-s-<instance>-…` and a reaper only touches its own instance's labs. Tested. |
| B25 | The server needs `sudo breakfix-clab`, so its systemd unit cannot set `NoNewPrivileges`/`ProtectSystem`. | Lighter sandboxing documented in docs/security.md; the fix (wrapper behind a root socket) is in IDEAS.md. |
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
- [x] Owner runs `sudo scripts/bootstrap.sh` (28 Sep).
- [x] Spike: FRR 10.7.1 runs unprivileged under userns-remap with `CapDrop=ALL`; vtysh works through the guard; no route to the internet. Router caps measured with a two-router OSPF + BGP lab, removing one cap per run: 8 needed, `FOWNER` and `KILL` dropped (docs/security.md).
- [x] Owner re-ran `sudo scripts/bootstrap.sh` to install the tightened policy: 8 router caps, `/etc/frr` directory bind, `TERM` for interactive vtysh, batched `show` commands, quieter guard log. Caps re-measured with the directory bind: all 8 still needed.
- [x] Infra tests green (`pnpm test:infra`, 30 tests): host preparation, 14 wrapper refusals, lab hardening, `write memory`, wiring, no internet.
- [x] Public repo `buildwithabid/network-breakfix-lab` created and pushed (gitleaks clean).

### M1: Scenario kit + scenario 1 end to end (CLI)
- [x] zod schema for `scenario.yaml` (id, title, difficulty, time limit, ticket, objectives, hints) and the allowed subset of `topology.clab.yml`. The loader cross-checks roles, rule nodes, links and variant dirs, and reports every problem at once.
- [x] Renderer: scenario + variant (baseline | fault | workaround) → lab dir with a unique `bfx-t-*` name, the `/etc/frr` bind and the measured caps.
- [x] Checker engine: pure, with deduplicated probes. Unit-tested against real JSON captured from FRR 10.7.1 (healthy and broken OSPF/BGP). Rule types: `reachability`, `route-present`, `ospf-neighbor`, `bgp-session`, `prefix-received`.
- [x] Lab runner: deploy through `breakfix-clab`, exec through `docker-guard`, wait for routers, destroy. Active labs are destroyed on SIGINT/SIGTERM and on failure.
- [x] `pnpm scenario:test <id>` and `--all` (B18 semantics). Variants run in parallel.
- [x] Scenario 01 (wrong mask on r2's transit link; the workaround host route is caught). Self-test green on real labs (baseline 9 s, fault 36 s); also runs in `pnpm test:infra`.
- [x] `docs/scenarios.md` (authoring guide).

### M2: Scenarios 2–5
- [x] 02 missing default route (workaround: per-destination static routes)
- [x] 03 OSPF hello/dead timer mismatch (workaround: static routes on all routers)
- [x] 04 BGP session down, wrong remote-as (workaround: static routes)
- [x] 05 prefix-list silently filtering the new LAN (workaround: removing the filter leaks the management /32; caught by a negated objective, B20)
- [x] `pnpm scenario:test --all` green: 5/5, every workaround caught

### M3: Server
- [x] SQLite schema + migrations (tests, sessions, commands, config snapshots, objective results) and a versioned assessment bundle per session (`docs/results.md`); no AI.
- [x] Session API: redeem a test link (single use, 256-bit, stored hashed), session view, submit, results, bundle. Rate-limited redemption. Cookie auth (HttpOnly, SameSite=Strict).
- [x] Lab lifecycle: FIFO queue behind a concurrency cap (default 5); per-node limits from the wrapper; timeout → auto-submit → destroy; resume after a restart.
- [x] Reaper: at start and every minute.
- [x] WebSocket: router terminal = interactive `vtysh` TTY through `docker-guard`; host = restricted console (validated argv, no shell).
- [x] Command capture via a headless xterm (tab completion, history and paste handled; tested).
- [x] Config capture at start and submit; unified diff.
- [x] Live state poller (interfaces, OSPF, BGP, routes) → topology state over the socket; never in the command log.
- [x] Packet path for pings/traceroutes (host console and vtysh), forward and back (B23).
- [x] Security tests: vtysh escapes, host-console injection, no internet, tokens, cookies, rate limit, origin, log redaction, headers, not-root, reaper, polling not logged; plus a boot test of the built server.

### M4: Web UI → then STOP
- [x] Test landing page (`/t/<token>`): preview (title, difficulty, time, devices), rules, start; the token leaves the address bar at once; queue position while waiting.
- [x] Workspace: ticket, hints (logged), countdown, live topology as the main screen (link up/down, OSPF and BGP status, interface names, legend, packet animation out and back with the drop reason), click a node to open its terminal tab, host console tabs, submit with confirmation.
- [x] Results: pass/fail per objective with the reason, time taken, per-device command log with timestamps, config diff per router, JSON download.
- [x] Desktop-first, usable at 390 px (no sideways scrolling; opening a device scrolls to its terminal).
- [x] Playwright e2e on real labs: scenario 01 fixed in the browser (4/4), a shut link turns red, phone-width run.
- [x] Deploy: `breakfix-server.service` as `breakfix` on :8480 with basic auth; `scripts/deploy.sh`; verified end to end on the live service.
- [x] **STOP**: URL, login and screenshots sent to the owner. Waiting for feedback.

### M5: Admin (after owner feedback)
- [ ] Admin login (password from env, hashed compare, rate-limited).
- [ ] Create test links per scenario; list sessions and results; open any result page.

### M6: Portfolio polish
- [ ] README: Mermaid architecture diagram, screenshots, demo GIF (Playwright video → ffmpeg).
- [ ] `docs/adr/`: why FRR, why containerlab, why vtysh-only, why SQLite, and the privilege-separation design (B3/B4).
- [ ] GitHub Actions: unit tests + scenario self-tests (runner installs pinned Docker/containerlab through `bootstrap.sh`).
- [ ] `/metrics` (Prometheus): active sessions, queue length, deploy time, reaper actions, check results.
- [ ] HTTPS via Caddy once the domain arrives (B8).
