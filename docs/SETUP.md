# Setup

## Requirements

- Debian 13 (trixie), amd64, cgroup v2 (the Debian default). No KVM needed: every node is a container.
- A user account with sudo for the one-time bootstrap. Day-to-day work needs no root.
- About 2 GB free RAM and 3 GB disk for images; each running lab uses roughly 300 MB.

## 1. Bootstrap the host (root, once)

```bash
git clone https://github.com/buildwithabid/network-breakfix-lab.git
cd network-breakfix-lab
sudo scripts/bootstrap.sh
```

The script is idempotent; run it again after pulling changes to anything under `infra/` or
`scripts/versions.env`. It:

1. installs Docker CE, containerd and buildx at the versions pinned in `scripts/versions.env`, with
   `userns-remap`, `no-new-privileges` and `cgroup-parent: breakfix.slice` in `/etc/docker/daemon.json`;
2. installs containerlab from its release `.deb` (sha256-checked), removes its setuid bit and empties
   the `clab_admins` group;
3. creates the `breakfix` (server) and `bfx-guard` (Docker proxy) system users, and adds you to the
   `breakfix` group;
4. installs `breakfix-clab` and `breakfix-docker-guard` into `/usr/local`, the `docker-guard` service,
   and the sudoers rule `/etc/sudoers.d/breakfix`;
5. pulls the FRRouting image by digest, builds the `breakfix-host` image, and records both image IDs
   in `/etc/breakfix/images.json`.

It does **not** add anyone to the `docker` group. Log out and back in (or use `sg breakfix -c '…'`)
so your shell picks up the `breakfix` group.

## 2. Developer tools and dependencies (no root)

```bash
scripts/dev-tools.sh          # pinned gitleaks + shellcheck into .tools/bin, enables .githooks
corepack enable --install-directory ~/.local/bin pnpm
pnpm install
```

## 3. Checks

```bash
pnpm check        # typecheck, eslint, shellcheck, unit tests, root-helper tests
pnpm test:infra   # needs step 1: deploys a real lab and checks its hardening
```

## Moving to another host

1. Run step 1 on the new host.
2. Copy `/var/lib/breakfix` (the SQLite database, from M3 onward) and `.env`.
3. Nothing else carries state: labs are disposable and the reaper removes leftovers.

## Uninstall

```bash
sudo systemctl disable --now breakfix-docker-guard
sudo rm -f /etc/sudoers.d/breakfix /usr/local/sbin/breakfix-clab /usr/local/sbin/breakfix-docker-guard \
  /etc/systemd/system/breakfix-docker-guard.service /etc/systemd/system/breakfix.slice
sudo rm -rf /usr/local/lib/breakfix /etc/breakfix /var/lib/breakfix-clab
sudo apt-mark unhold containerlab docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo apt-get purge containerlab docker-ce docker-ce-cli containerd.io docker-buildx-plugin
```
