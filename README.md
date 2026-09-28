# Network Break/Fix Lab

A network troubleshooting simulator with real routers. A candidate opens a test link, reads a
ticket ("Branch users can't reach the server at 10.0.3.10"), sees a live topology diagram, and fixes
the fault in real router CLIs in the browser. Routers are [FRRouting](https://frrouting.org)
containers and hosts are small Linux containers, wired by [containerlab](https://containerlab.dev).
On submit, a checker verifies the network was fixed the intended way.

> **Status:** milestone M0 (host bootstrap and privilege separation). See [PLAN.md](PLAN.md).

## Why it is built this way

Candidates get a live CLI on infrastructure you run, so the design starts from security:

- candidates get `vtysh` only, never a shell; hosts get a whitelisted command console;
- the server never touches the Docker socket: a policy proxy (`docker-guard`) allows only lab
  inspection and whitelisted execs;
- the only root entry point is `breakfix-clab`, which validates every topology before containerlab
  sees it;
- lab containers are unprivileged, drop all capabilities except a documented few, run under
  user-namespace remapping, and have no network path to the internet.

Details: [docs/security.md](docs/security.md).

## Quick start

See [docs/SETUP.md](docs/SETUP.md). In short:

```bash
sudo scripts/bootstrap.sh     # Debian 13: Docker, containerlab, images, guard, wrapper
scripts/dev-tools.sh
pnpm install
pnpm check                    # lint, typecheck, unit + helper tests
pnpm test:infra               # deploys a real lab and verifies its hardening
```

## Layout

| Path | Contents |
|---|---|
| `apps/server` | Fastify API, WebSocket terminals, lab lifecycle (M3) |
| `apps/web` | React UI: ticket, live topology, terminals, results (M4) |
| `packages/scenario-kit` | scenario schema, loader, lab runner, checker (M1) |
| `scenarios/` | one folder per scenario (M1–M2) |
| `infra/` | root-side helpers (`breakfix-clab`, `docker-guard`), systemd units, host image |
| `scripts/` | `bootstrap.sh`, `dev-tools.sh`, pinned `versions.env` |
| `tests/infra` | tests that need a bootstrapped host |

## License

MIT
