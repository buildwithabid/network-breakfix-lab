# Network Break/Fix Lab: standing project rules

Read this file, `CLAUDE.local.md` (host-specific, not committed) and `PLAN.md` before doing
anything. PLAN.md holds milestones, status and decisions; this file holds the rules that do not
change between milestones.

## What this is

A web app that trains and tests real network troubleshooting. A candidate opens a test link, reads
a ticket, sees a live topology diagram and fixes the fault in real router CLIs in the browser. Every
router is a real FRRouting container and every host a small Linux container, wired by containerlab.
On submit, a checker verifies the network was fixed the intended way, and the results page shows
each objective's pass/fail, time taken, every command typed per device and the config diff.

Public portfolio project: code quality, tests, security and docs weigh as much as features.

## Hard boundaries

- Work only inside this repository and the paths it owns (`/srv/breakfix`, `/var/lib/breakfix`,
  `/run/breakfix`, the `breakfix.slice` cgroup). This host also runs unrelated production services:
  never read, stop, restart or modify anything else. `CLAUDE.local.md` lists them.
- Docker objects: touch only what this project created. Every lab name starts with `bfx-`. Never
  run `docker system prune`, never remove containers, networks or images by a broad pattern.
- Never `playwright install` into the shared cache. Browsers live in `./.pw-browsers`
  (`PLAYWRIGHT_BROWSERS_PATH`, set by the package scripts).
- No sudo for the agent. Root-owned pieces (Docker install, `breakfix-clab` wrapper, `docker-guard`
  proxy, sudoers rules, `breakfix.slice`) change only by editing them in `scripts/` and having the
  owner re-run `sudo scripts/bootstrap.sh`. Hand that over as a single ready-to-paste line.
- Build only what PLAN.md lists. New ideas go in `IDEAS.md`, not into code.
- If the brief is technically wrong or blocks progress, say so, propose the smallest fix and record
  it under "Decisions and brief issues" in PLAN.md. Never silently work around it.
- **STOP after M4**: serve it, send the URL and Playwright screenshots, wait for feedback.

## Stack (fixed)

TypeScript (strict) everywhere except the two root-side helpers (PLAN.md B11), pnpm workspaces, Node 22 LTS.

| Package | Holds |
|---|---|
| `apps/server` | Fastify + ws, dockerode (through `docker-guard`), containerlab (through `breakfix-clab`), better-sqlite3, zod, pino, `@xterm/headless` for command capture |
| `apps/web` | Vite + React, xterm.js terminals, SVG topology rendered from scenario data |
| `packages/scenario-kit` | scenario schema (zod), loader, topology renderer, checker engine, `scenario:test` CLI |
| `scenarios/<id>/` | `scenario.yaml`, `topology.clab.yml`, `baseline/`, `fault/`, `workaround/` |
| `infra/` | root-side helpers in stdlib Python (`bfx_infra`: `breakfix-clab` wrapper, `docker-guard` proxy), systemd units, host image |
| `scripts/` | `bootstrap.sh` (root, idempotent), `dev-tools.sh`, pinned `versions.env` |
| `tests/infra/` | Vitest tests that need a bootstrapped host and deploy real labs |

Dependency rule: `scenario-kit` imports nothing from `apps/`; `apps/web` never imports server code
(shared types come from `scenario-kit` or a `types` export of it).

Tests: Vitest (unit), integration tests that deploy real labs, Playwright (e2e, headless, fresh
browser context per test).

## Privilege model (the core security design)

```
browser ──HTTPS/WS──> server (user breakfix: no root, no docker group)
                         ├─ sudo breakfix-clab deploy|destroy|list   root-owned, validates the
                         │                                           topology against an allowlist,
                         │                                           injects caps and limits
                         └─ docker-guard (unix socket)               allows only: list/inspect bfx-*
                                                                     containers, exec of allowlisted
                                                                     argv (vtysh, host console cmds)
                                                                     ──> dockerd
lab containers: no --privileged, cap-drop ALL + documented minimum, CPU/mem/PID limits,
no route to the internet, all inside breakfix.slice (global cap protects the host)
```

Security rules. Each one has an automated test, and a change that weakens one needs a PLAN.md entry:

1. Candidates get `vtysh` only, never a shell. `VTYSH_PAGER=cat` is forced on every exec (the pager
   is a shell escape). Tests try `start-shell`, `terminal paginate` + long output, and other escapes.
2. Hosts get no shell: a restricted console runs only `ping`, `traceroute`, `ip addr`, `ip route`
   with zod-validated arguments, executed as an argv array (never through a shell).
3. No `--privileged`. Capabilities are exactly the set in `docs/security.md`, with the reason for each.
4. Lab containers have no outbound internet access.
5. The server runs as `breakfix`, not root, not in the `docker` group. Its only paths to root are
   `breakfix-clab` and `docker-guard`, and both refuse anything outside their allowlist.
6. Test links are 256-bit random tokens, stored hashed; session creation is rate-limited; HTTPS in
   production.
7. The server's own polling commands never appear in a candidate's command log.

## Conventions

- Pin every version: exact npm versions (no `^`/`~`), lockfile committed, images pinned by tag and
  digest, containerlab and Docker pinned in `bootstrap.sh`.
- Secrets only in `.env` (gitignored); `.env.example` lists every variable with a safe placeholder.
  gitleaks runs before every push.
- Structured logs via pino; never log tokens, passwords or full request bodies.
- Commit author: `Abid Ali <abidtech2017@gmail.com>`. Commit after each milestone with tests green.
- Keep README.md and docs/ current at every milestone.

## Commands

| Command | Does |
|---|---|
| `pnpm check` | typecheck, eslint, shellcheck, unit tests, root-helper tests. Run before every commit |
| `pnpm test:infra` | real-lab tests; needs the bootstrapped host. Until the shell has the `breakfix` group, run `sg breakfix -c 'pnpm test:infra'` |
| `pnpm test:helpers` | Python unit tests for `infra/bfx_infra` (no root, no Docker) |
| `scripts/dev-tools.sh` | pinned gitleaks + shellcheck into `.tools/bin`, enables the pre-push hook |
| `sudo scripts/bootstrap.sh` | owner only; re-run after changing anything in `infra/` or `scripts/versions.env` |
| `sudo -n /usr/local/sbin/breakfix-clab list` | labs currently deployed |
