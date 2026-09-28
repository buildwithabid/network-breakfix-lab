# Network Break/Fix Lab

A network troubleshooting simulator with real routers. A candidate opens a test link, reads a
ticket ("Branch users can't reach the server at 10.0.3.10"), sees a live topology diagram, and fixes
the fault in real router CLIs in the browser. Routers are [FRRouting](https://frrouting.org)
containers and hosts are small Linux containers, wired by [containerlab](https://containerlab.dev).
On submit, a checker verifies the network was fixed the intended way.

> **Status:** M4 done: five self-tested scenarios, the server and the web UI (live diagram, terminals,
> results), running as a service. Admin UI and portfolio polish follow (M5–M6). See [PLAN.md](PLAN.md).

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
pnpm test:infra               # deploys real labs: hardening checks and scenario self-tests
pnpm scenario:test --all      # self-test every scenario: baseline passes, fault fails, workaround is caught
sg breakfix -c 'pnpm test:e2e'   # Playwright on real labs (browsers in ./.pw-browsers)
```

Writing a scenario: [docs/scenarios.md](docs/scenarios.md). Results and the assessment bundle:
[docs/results.md](docs/results.md).

Run the server (after `pnpm install`; settings in [.env.example](.env.example)):

```bash
pnpm admin link 01-wrong-ip-mask   # prints a single-use test link
pnpm server                         # http://127.0.0.1:8480
```

## Layout

| Path | Contents |
|---|---|
| `apps/server` | Fastify API, WebSocket terminals, sessions and lab lifecycle, live state, results |
| `apps/web` | React UI: landing page, ticket, live topology, xterm.js terminals, results |
| `packages/scenario-kit` | scenario schema, loader, renderer, checker, lab runner, `scenario:test` CLI |
| `scenarios/` | one folder per scenario |
| `infra/` | root-side helpers (`breakfix-clab`, `docker-guard`), systemd units, host image |
| `scripts/` | `bootstrap.sh`, `dev-tools.sh`, pinned `versions.env` |
| `tests/infra` | tests that need a bootstrapped host |
| `e2e/` | Playwright tests against the real server and real labs |

## License

MIT
