/**
 * Values that must match the host set up by scripts/bootstrap.sh and the root-side policy in
 * infra/bfx_infra/policy.py. A mismatch is not a security problem (the wrapper and the guard
 * refuse anything outside their policy); it only makes deploys fail.
 */

export const ROUTER_IMAGE = "quay.io/frrouting/frr:10.7.1";
export const HOST_IMAGE = "breakfix-host:0.1.0";

export const CLAB_WRAPPER = process.env.BFX_CLAB_WRAPPER ?? "/usr/local/sbin/breakfix-clab";
export const GUARD_SOCKET = process.env.BFX_GUARD_SOCKET ?? "/run/breakfix-guard/app.sock";

/** Measured minimum for FRR 10.7.1; see docs/security.md. */
export const ROUTER_CAPS = [
  "CHOWN",
  "DAC_OVERRIDE",
  "NET_ADMIN",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETGID",
  "SETUID",
  "SYS_ADMIN",
] as const;
export const HOST_CAPS = ["NET_ADMIN", "NET_RAW"] as const;

export const ROUTER_CONFIG_DIR = "/etc/frr";

/** zebra, mgmtd and staticd always run; OSPF and BGP are enabled in every lab. */
export const DEFAULT_DAEMONS = `# FRR 10.7 daemons file (network-breakfix-lab default)
bgpd=yes
ospfd=yes
ospf6d=no
ripd=no
ripngd=no
isisd=no
pimd=no
pim6d=no
ldpd=no
nhrpd=no
eigrpd=no
babeld=no
sharpd=no
pbrd=no
bfdd=no
fabricd=no
vrrpd=no
pathd=no
vtysh_enable=yes
zebra_options="  -A 127.0.0.1 -s 90000000"
mgmtd_options="  -A 127.0.0.1"
staticd_options="-A 127.0.0.1"
bgpd_options="   -A 127.0.0.1"
ospfd_options="  -A 127.0.0.1"
`;

/** Without this file vtysh prints a warning on every start, even before JSON output. */
export const DEFAULT_VTYSH_CONF = "service integrated-vtysh-config\n";

/** How long a lab gets to converge before a fault or workaround variant is judged. */
export const SETTLE_MS = 20_000;
/** How long a baseline may take to reach all-pass before the self-test gives up. */
export const BASELINE_TIMEOUT_MS = 120_000;
