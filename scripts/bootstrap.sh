#!/usr/bin/env bash
# Host bootstrap for network-breakfix-lab. Idempotent: safe to run again at any time.
#
#   sudo scripts/bootstrap.sh
#
# Installs pinned Docker CE and containerlab, the lab images, and the privilege-separation pieces
# (breakfix-clab wrapper, docker-guard proxy, sudoers rule, breakfix.slice). Every version it
# installs is pinned in scripts/versions.env. See docs/SETUP.md and docs/security.md.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/versions.env
source "$REPO_DIR/scripts/versions.env"
DEV_USER="${BFX_DEV_USER:-${SUDO_USER:-}}"
INFRA="$REPO_DIR/infra"
CHANGED_GUARD=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

# install_file SRC DEST MODE OWNER:GROUP -> returns 0 if the file changed, 1 if already identical
install_file() {
  local src="$1" dest="$2" mode="$3" owner="$4"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest" \
     && [[ "$(stat -c '%a %U:%G' "$dest")" == "${mode#0} $owner" ]]; then
    return 1
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest"
  return 0
}

pkg_version() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || true; }
in_group() { [[ " $(id -nG "$1") " == *" $2 "* ]]; }

# --------------------------------------------------------------------------------------------
log "Preflight"
[[ $EUID -eq 0 ]] || die "run as root: sudo $0"
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "13" ]] \
  || [[ "${BFX_ALLOW_ANY_OS:-0}" == "1" ]] || die "Debian 13 required (found ${PRETTY_NAME:-unknown})"
[[ "$(uname -m)" == "x86_64" ]] || die "amd64 only"
[[ "$(stat -fc %T /sys/fs/cgroup)" == "cgroup2fs" ]] || die "cgroup v2 required"
if [[ -z "$DEV_USER" || "$DEV_USER" == "root" ]]; then
  warn "no developer user (run via sudo or set BFX_DEV_USER); only the service user gets access"
  DEV_USER=""
fi
ok "Debian ${VERSION_ID}, dev user: ${DEV_USER:-none}"

# --------------------------------------------------------------------------------------------
log "Base packages"
need=()
for p in ca-certificates curl gnupg python3 python3-yaml iptables; do
  [[ -n "$(pkg_version "$p")" ]] || need+=("$p")
done
if ((${#need[@]})); then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${need[@]}"
fi
ok "present"

# --------------------------------------------------------------------------------------------
log "Node.js ${NODE_MAJOR}"
if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]]; then
  ok "node $(node --version) already installed"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
EOF
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "nodejs=${NODE_DEB_VERSION}"
  ok "node $(node --version) installed"
fi
command -v corepack >/dev/null || die "corepack missing (ships with Node ${NODE_MAJOR})"

# --------------------------------------------------------------------------------------------
log "Users and groups"
getent group breakfix >/dev/null || groupadd --system breakfix
id breakfix >/dev/null 2>&1 || useradd --system --gid breakfix --home-dir /var/lib/breakfix \
  --no-create-home --shell /usr/sbin/nologin breakfix
getent group bfx-guard >/dev/null || groupadd --system bfx-guard
id bfx-guard >/dev/null 2>&1 || useradd --system --gid bfx-guard --home-dir /nonexistent \
  --no-create-home --shell /usr/sbin/nologin bfx-guard
if [[ -n "$DEV_USER" ]]; then
  in_group "$DEV_USER" breakfix || usermod -aG breakfix "$DEV_USER"
fi
ok "breakfix, bfx-guard${DEV_USER:+, $DEV_USER in group breakfix}"

# --------------------------------------------------------------------------------------------
log "Resource cap and Docker daemon config (written before Docker first starts)"
if install_file "$INFRA/systemd/breakfix.slice" /etc/systemd/system/breakfix.slice 0644 root:root; then
  systemctl daemon-reload
  ok "breakfix.slice installed"
else
  ok "breakfix.slice unchanged"
fi
DAEMON_CHANGED=0
if install_file "$INFRA/daemon.json" /etc/docker/daemon.json 0644 root:root; then
  DAEMON_CHANGED=1
  ok "daemon.json installed"
else
  ok "daemon.json unchanged"
fi

# --------------------------------------------------------------------------------------------
log "Docker CE ${DOCKER_CE_VERSION%%-*}"
install -d -m 0755 /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
fi
fpr="$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '/^fpr/{print $10; exit}')"
[[ "$fpr" == "$DOCKER_GPG_FINGERPRINT" ]] || die "Docker apt key fingerprint mismatch: $fpr"
DOCKER_SOURCES=/etc/apt/sources.list.d/docker.sources
tmp_sources="$(mktemp)"
cat > "$tmp_sources" <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
if install_file "$tmp_sources" "$DOCKER_SOURCES" 0644 root:root; then apt-get update -q; fi
rm -f "$tmp_sources"
if [[ "$(pkg_version docker-ce)" != "$DOCKER_CE_VERSION" \
   || "$(pkg_version containerd.io)" != "$CONTAINERD_VERSION" \
   || "$(pkg_version docker-buildx-plugin)" != "$BUILDX_VERSION" ]]; then
  apt-mark unhold docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades \
    "docker-ce=${DOCKER_CE_VERSION}" "docker-ce-cli=${DOCKER_CE_VERSION}" \
    "containerd.io=${CONTAINERD_VERSION}" "docker-buildx-plugin=${BUILDX_VERSION}"
  DAEMON_CHANGED=0 # fresh install started with the new daemon.json already in place
fi
apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
systemctl enable --now docker.service >/dev/null
if ((DAEMON_CHANGED)); then
  running="$(docker ps -q --filter label=containerlab | wc -l)"
  ((running == 0)) || warn "restarting Docker stops $running running lab container(s)"
  systemctl restart docker.service
  CHANGED_GUARD=1
fi
[[ "$(docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}')" == "systemd 2" ]] \
  || die "Docker must use the systemd cgroup driver on cgroup v2"
[[ "$(docker info --format '{{json .SecurityOptions}}')" == *name=userns* ]] \
  || die "Docker userns-remap is not active"
ok "docker $(docker version --format '{{.Server.Version}}') (userns-remap on, cgroup parent breakfix.slice)"

# --------------------------------------------------------------------------------------------
log "containerlab ${CONTAINERLAB_VERSION}"
if [[ "$(pkg_version containerlab)" != "$CONTAINERLAB_VERSION" ]]; then
  deb="$(mktemp --suffix=.deb)"
  curl -fsSL -o "$deb" \
    "https://github.com/srl-labs/containerlab/releases/download/v${CONTAINERLAB_VERSION}/containerlab_${CONTAINERLAB_VERSION}_linux_amd64.deb"
  echo "${CONTAINERLAB_DEB_SHA256}  $deb" | sha256sum -c --quiet - || die "containerlab checksum mismatch"
  apt-mark unhold containerlab >/dev/null 2>&1 || true
  # SUDO_USER unset so the package's postinst does not add anyone to clab_admins.
  env -u SUDO_USER dpkg -i "$deb"
  rm -f "$deb"
fi
apt-mark hold containerlab >/dev/null
# The package makes containerlab setuid root for members of clab_admins ("sudo-less" mode).
# Here only root runs it, through breakfix-clab, so undo both.
chmod 0755 /usr/bin/containerlab
if getent group clab_admins >/dev/null; then gpasswd -M '' clab_admins >/dev/null; fi
ok "containerlab $(containerlab version 2>/dev/null | awk '/version:/{print $2}'), not setuid, clab_admins empty"

# --------------------------------------------------------------------------------------------
log "Directories"
install -d -m 0755 -o root -g root /etc/breakfix /usr/local/lib/breakfix
install -d -m 0711 -o root -g root /var/lib/breakfix-clab /var/lib/breakfix-clab/labs
install -d -m 0750 -o breakfix -g breakfix /var/lib/breakfix
if [[ -n "$DEV_USER" ]]; then
  install -d -m 2750 -o "$DEV_USER" -g breakfix /srv/breakfix
else
  install -d -m 2750 -o root -g breakfix /srv/breakfix
fi
ok "/etc/breakfix /var/lib/breakfix /var/lib/breakfix-clab /srv/breakfix"

# --------------------------------------------------------------------------------------------
log "Root helpers (breakfix-clab, docker-guard)"
in_group bfx-guard docker || usermod -aG docker bfx-guard
in_group bfx-guard breakfix || usermod -aG breakfix bfx-guard
install -d -m 0755 -o root -g root /usr/local/lib/breakfix/bfx_infra
for f in "$INFRA"/bfx_infra/*.py; do
  if install_file "$f" "/usr/local/lib/breakfix/bfx_infra/$(basename "$f")" 0644 root:root; then CHANGED_GUARD=1; fi
done
# remove modules that no longer exist in the repo
for f in /usr/local/lib/breakfix/bfx_infra/*.py; do
  [[ -f "$INFRA/bfx_infra/$(basename "$f")" ]] || { rm -f "$f"; CHANGED_GUARD=1; }
done
rm -rf /usr/local/lib/breakfix/bfx_infra/__pycache__
install_file "$INFRA/bin/breakfix-clab" /usr/local/sbin/breakfix-clab 0755 root:root || true
if install_file "$INFRA/bin/breakfix-docker-guard" /usr/local/sbin/breakfix-docker-guard 0755 root:root; then CHANGED_GUARD=1; fi
ok "installed under /usr/local"

log "sudoers rule"
users="breakfix${DEV_USER:+, $DEV_USER}"
tmp_sudoers="$(mktemp)"
cat > "$tmp_sudoers" <<EOF
# Managed by network-breakfix-lab scripts/bootstrap.sh. Do not edit by hand.
# The only root command available to the lab server and the developer. It validates its input;
# see docs/security.md.
Defaults!/usr/local/sbin/breakfix-clab env_reset, !setenv
User_Alias BFX_CLAB_USERS = ${users}
BFX_CLAB_USERS ALL=(root) NOPASSWD: /usr/local/sbin/breakfix-clab
EOF
visudo -cq -f "$tmp_sudoers" || die "generated sudoers file is invalid"
install_file "$tmp_sudoers" /etc/sudoers.d/breakfix 0440 root:root || true
rm -f "$tmp_sudoers"
if ! visudo -cq; then # never leave sudo broken
  rm -f /etc/sudoers.d/breakfix
  die "sudoers failed validation after adding /etc/sudoers.d/breakfix; removed it again"
fi
ok "/etc/sudoers.d/breakfix (${users})"

# --------------------------------------------------------------------------------------------
log "Lab images"
frr_pinned="${FRR_IMAGE_REF%%:*}@${FRR_IMAGE_DIGEST}"
if ! docker image inspect "$frr_pinned" >/dev/null 2>&1; then
  docker pull -q "$frr_pinned" >/dev/null
fi
docker tag "$frr_pinned" "$FRR_IMAGE_REF"
frr_id="$(docker image inspect -f '{{.Id}}' "$FRR_IMAGE_REF")"
ok "$FRR_IMAGE_REF -> $frr_id"

dockerfile_sha="$(sha256sum "$INFRA/docker/breakfix-host/Dockerfile" | cut -c1-64)"
current_sha="$(docker image inspect -f '{{index .Config.Labels "org.breakfix.dockerfile-sha256"}}' "$HOST_IMAGE_REF" 2>/dev/null || true)"
if [[ "$current_sha" != "$dockerfile_sha" ]]; then
  build_args=(build -q --label "org.breakfix.dockerfile-sha256=${dockerfile_sha}" -t "$HOST_IMAGE_REF" "$INFRA/docker/breakfix-host")
  if ! docker "${build_args[@]}" >/dev/null; then
    warn "BuildKit build failed; retrying with the classic builder"
    DOCKER_BUILDKIT=0 docker "${build_args[@]}" >/dev/null
  fi
fi
host_id="$(docker image inspect -f '{{.Id}}' "$HOST_IMAGE_REF")"
ok "$HOST_IMAGE_REF -> $host_id"

tmp_images="$(mktemp)"
cat > "$tmp_images" <<EOF
{
  "router": { "ref": "${FRR_IMAGE_REF}", "id": "${frr_id}" },
  "host": { "ref": "${HOST_IMAGE_REF}", "id": "${host_id}" }
}
EOF
if install_file "$tmp_images" /etc/breakfix/images.json 0644 root:root; then CHANGED_GUARD=1; fi
rm -f "$tmp_images"

# --------------------------------------------------------------------------------------------
log "docker-guard service"
if install_file "$INFRA/systemd/breakfix-docker-guard.service" \
     /etc/systemd/system/breakfix-docker-guard.service 0644 root:root; then
  systemctl daemon-reload
  CHANGED_GUARD=1
fi
systemctl enable breakfix-docker-guard.service >/dev/null 2>&1
if ((CHANGED_GUARD)) || ! systemctl is-active --quiet breakfix-docker-guard.service; then
  systemctl restart breakfix-docker-guard.service
fi
for _ in $(seq 1 50); do [[ -S /run/breakfix-guard/app.sock ]] && break; sleep 0.1; done
[[ -S /run/breakfix-guard/app.sock && -S /run/breakfix-guard/deploy.sock ]] \
  || die "docker-guard sockets did not appear (journalctl -u breakfix-docker-guard)"
ok "active, sockets in /run/breakfix-guard"

# --------------------------------------------------------------------------------------------
log "Verification"
[[ ! -u /usr/bin/containerlab ]] || die "containerlab is setuid"
/usr/local/sbin/breakfix-clab list >/dev/null || die "breakfix-clab list failed"
if [[ -n "$DEV_USER" ]]; then
  if in_group "$DEV_USER" docker; then
    warn "$DEV_USER is in the docker group, which is root-equivalent; the design assumes it is not"
  fi
  sudo -n -l -U "$DEV_USER" /usr/local/sbin/breakfix-clab >/dev/null || die "sudo rule not effective"
fi
ok "breakfix-clab runs; sudo rule effective"
cat <<EOF

Bootstrap complete.
  docker        $(docker version --format '{{.Server.Version}}')
  containerlab  ${CONTAINERLAB_VERSION}
  router image  ${FRR_IMAGE_REF}
  host image    ${HOST_IMAGE_REF}
  cap           breakfix.slice (MemoryMax 3G, CPUQuota 200%, TasksMax 4096)
EOF
[[ -z "$DEV_USER" ]] || echo "  note: ${DEV_USER} must start a new login session (or use 'sg breakfix') to use the guard socket"
