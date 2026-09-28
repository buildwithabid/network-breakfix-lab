"""Security policy shared by breakfix-clab (the wrapper) and docker-guard (the API proxy).

Everything in this module is pure: no I/O, no Docker, no root. That keeps every rule unit-testable.
Three questions are answered here:

* Is this containerlab topology allowed to be deployed?   -> validate_topology()
* Is this container-create request allowed (and how is it hardened)?  -> sanitize_create()
* Is this exec request allowed (and with which environment)?  -> sanitize_exec()
"""

from __future__ import annotations

import ipaddress
import json
import posixpath
import re
from dataclasses import dataclass, field
from typing import Any


class PolicyError(Exception):
    """A request falls outside the policy. The message is safe to show to the caller."""


# ---------------------------------------------------------------------------------------------
# Names and limits
# ---------------------------------------------------------------------------------------------

LAB_NAME_RE = re.compile(r"^bfx-[a-z0-9]+(?:-[a-z0-9]+)*$")
LAB_NAME_MAX = 40
NODE_NAME_RE = re.compile(r"^[a-z][a-z0-9]{0,14}$")
IFACE_RE = re.compile(r"^eth(?:[1-9]|[12][0-9]|3[0-2])$")
REL_PATH_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*){0,3}$")
CONTAINER_PREFIX = "clab"

MAX_NODES = 16
MAX_LINKS = 32
MAX_EXEC_PER_NODE = 16
MAX_TOPOLOGY_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 256 * 1024

ROLES = ("router", "host")

# Linux capabilities per role. The guard always sends CapDrop=["ALL"] and then adds back only the
# capabilities the topology asked for, which must be a subset of this set. The router set is the
# measured minimum for FRR 10.7.1 (OSPF, BGP, static, `write memory`); docs/security.md explains
# each one. FRR's daemons request SYS_ADMIN at start-up (lib/privs.c exits if cap_set_proc fails);
# user-namespace remapping keeps it from meaning anything outside the container.
CAPS_MAX: dict[str, frozenset[str]] = {
    "router": frozenset(
        {
            "CHOWN",
            "DAC_OVERRIDE",
            "NET_ADMIN",
            "NET_BIND_SERVICE",
            "NET_RAW",
            "SETGID",
            "SETUID",
            "SYS_ADMIN",
        }
    ),
    "host": frozenset({"NET_ADMIN", "NET_RAW"}),
}

MIB = 1024 * 1024
CPU_PERIOD = 100_000
LIMITS: dict[str, dict[str, int]] = {
    "router": {"memory": 256 * MIB, "cpu_quota": 50_000, "pids": 256},
    "host": {"memory": 64 * MIB, "cpu_quota": 25_000, "pids": 64},
}

# A router's whole /etc/frr comes from one lab directory, so `write memory` can rename files there.
ROUTER_CONFIG_DIR = "/etc/frr"
ROUTER_CONFIG_FILES = ("frr.conf", "daemons", "vtysh.conf")
ROUTER_CONFIG_REQUIRED = ("frr.conf", "daemons")

ROUTER_SYSCTLS = {
    "net.ipv4.ip_forward": "1",
    "net.ipv6.conf.all.forwarding": "1",
    "net.ipv4.conf.all.rp_filter": "0",
    "net.ipv4.conf.default.rp_filter": "0",
}

_OCTET = r"(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
_IPV4 = rf"{_OCTET}(?:\.{_OCTET}){{3}}"
_CIDR = rf"{_IPV4}/(?:[0-9]|[12][0-9]|3[0-2])"
_IFACE = r"eth[0-9]{1,2}"

# The only commands a topology may run inside a host at deploy time (containerlab `exec:`).
HOST_EXEC_PATTERNS = (
    re.compile(rf"^ip link set (?P<iface>{_IFACE}) up$"),
    re.compile(rf"^ip addr add (?P<cidr>{_CIDR}) dev (?P<iface>{_IFACE})$"),
    re.compile(rf"^ip route add (?:default|{_CIDR}) via {_IPV4}(?: dev (?P<iface>{_IFACE}))?$"),
)


# ---------------------------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ImagePolicy:
    """The two images labs may use, by reference and by the exact image ID bootstrap recorded."""

    refs: dict[str, str]
    ids: dict[str, str]

    def role_for_ref(self, ref: str) -> str | None:
        for role, allowed in self.refs.items():
            if ref == allowed:
                return role
        return None

    @classmethod
    def from_json(cls, text: str) -> "ImagePolicy":
        data = json.loads(text)
        refs: dict[str, str] = {}
        ids: dict[str, str] = {}
        for role in ROLES:
            entry = data.get(role)
            if not isinstance(entry, dict):
                raise PolicyError(f"image policy has no entry for role {role!r}")
            ref, image_id = entry.get("ref"), entry.get("id")
            if not isinstance(ref, str) or not ref:
                raise PolicyError(f"image policy: bad ref for {role!r}")
            if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
                raise PolicyError(f"image policy: bad id for {role!r}")
            refs[role], ids[role] = ref, image_id
        return cls(refs=refs, ids=ids)


# ---------------------------------------------------------------------------------------------
# Topology validation (breakfix-clab deploy)
# ---------------------------------------------------------------------------------------------


@dataclass
class LabPlan:
    """A validated lab: the containerlab topology to write, and the files to copy into place."""

    name: str
    topology: dict[str, Any]
    config_dirs: dict[str, str] = field(default_factory=dict)  # router -> relative source dir
    roles: dict[str, str] = field(default_factory=dict)


def validate_lab_name(name: object) -> str:
    if not isinstance(name, str) or len(name) > LAB_NAME_MAX or not LAB_NAME_RE.fullmatch(name):
        raise PolicyError(
            f"lab name must match {LAB_NAME_RE.pattern} and be at most {LAB_NAME_MAX} characters"
        )
    return name


def _only_keys(where: str, obj: dict[str, Any], allowed: set[str]) -> None:
    extra = sorted(set(obj) - allowed)
    if extra:
        raise PolicyError(f"{where}: key(s) not allowed: {', '.join(extra)}")


def _check_rel_path(rel: str) -> str:
    if not REL_PATH_RE.fullmatch(rel) or ".." in rel.split("/"):
        raise PolicyError(f"bind source {rel!r} must be a plain relative path inside the lab")
    return rel


def _parse_config_bind(bind: object, where: str) -> str:
    """'<dir>:/etc/frr' or '<dir>:/etc/frr:rw' -> '<dir>'."""
    if not isinstance(bind, str):
        raise PolicyError(f"{where}: bind must be a string")
    parts = bind.split(":")
    if len(parts) not in (2, 3) or parts[1] != ROUTER_CONFIG_DIR or parts[2:] not in ([], ["rw"]):
        raise PolicyError(f"{where}: the only bind allowed is '<config-dir>:{ROUTER_CONFIG_DIR}'")
    return _check_rel_path(parts[0])


def _normalise_caps(caps: object, role: str, where: str) -> list[str]:
    if caps is None:
        return []
    if not isinstance(caps, list) or not all(isinstance(c, str) for c in caps):
        raise PolicyError(f"{where}: cap-add must be a list of strings")
    out = sorted({c.upper().removeprefix("CAP_") for c in caps})
    extra = [c for c in out if c not in CAPS_MAX[role]]
    if extra:
        raise PolicyError(f"{where}: capability not allowed for a {role}: {', '.join(extra)}")
    return out


def _validate_host_exec(commands: object, where: str) -> list[str]:
    if commands is None:
        return []
    if not isinstance(commands, list) or len(commands) > MAX_EXEC_PER_NODE:
        raise PolicyError(f"{where}: exec must be a list of at most {MAX_EXEC_PER_NODE} commands")
    out: list[str] = []
    for cmd in commands:
        if not isinstance(cmd, str):
            raise PolicyError(f"{where}: exec entries must be strings")
        match = next((p.fullmatch(cmd) for p in HOST_EXEC_PATTERNS if p.fullmatch(cmd)), None)
        if match is None:
            raise PolicyError(f"{where}: exec command not allowed: {cmd!r}")
        iface = match.groupdict().get("iface")
        if iface is not None and not IFACE_RE.fullmatch(iface):
            raise PolicyError(f"{where}: interface {iface!r} not allowed")
        cidr = match.groupdict().get("cidr")
        if cidr is not None:
            ipaddress.ip_interface(cidr)  # regex already bounds it; this double-checks
        out.append(cmd)
    return out


def validate_topology(doc: object, images: ImagePolicy, lab_dir: str) -> LabPlan:
    """Validate a containerlab topology and return the hardened version to deploy.

    lab_dir is the root-owned directory the lab's files will be copied into; bind sources in the
    returned topology point there, never at the caller's copy.
    """
    if not isinstance(doc, dict):
        raise PolicyError("topology must be a mapping")
    _only_keys("topology file", doc, {"name", "topology"})
    name = validate_lab_name(doc.get("name"))

    topo = doc.get("topology")
    if not isinstance(topo, dict):
        raise PolicyError("topology: missing 'topology' mapping")
    _only_keys("topology", topo, {"nodes", "links"})

    nodes = topo.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        raise PolicyError("topology.nodes must be a non-empty mapping")
    if len(nodes) > MAX_NODES:
        raise PolicyError(f"at most {MAX_NODES} nodes")

    config_dirs: dict[str, str] = {}
    roles: dict[str, str] = {}
    out_nodes: dict[str, Any] = {}

    for node_name, node in nodes.items():
        where = f"node {node_name!r}"
        if not isinstance(node_name, str) or not NODE_NAME_RE.fullmatch(node_name):
            raise PolicyError(f"{where}: name must match {NODE_NAME_RE.pattern}")
        if not isinstance(node, dict):
            raise PolicyError(f"{where}: must be a mapping")
        _only_keys(where, node, {"kind", "image", "binds", "exec", "cap-add"})
        if node.get("kind") != "linux":
            raise PolicyError(f"{where}: kind must be 'linux'")
        image = node.get("image")
        role = images.role_for_ref(image) if isinstance(image, str) else None
        if role is None:
            raise PolicyError(f"{where}: image {image!r} is not an allowed lab image")
        roles[node_name] = role

        binds = node.get("binds") or []
        if not isinstance(binds, list):
            raise PolicyError(f"{where}: binds must be a list")
        binds_out: list[str] = []
        if role == "router":
            if len(binds) != 1:
                raise PolicyError(
                    f"{where}: a router needs exactly one bind '<config-dir>:{ROUTER_CONFIG_DIR}'"
                )
            rel_dir = _parse_config_bind(binds[0], where)
            if rel_dir in config_dirs.values():
                raise PolicyError(f"{where}: config directory {rel_dir!r} is used by another router")
            config_dirs[node_name] = rel_dir
            binds_out.append(f"{posixpath.join(lab_dir, 'files', rel_dir)}:{ROUTER_CONFIG_DIR}")
        elif binds:
            raise PolicyError(f"{where}: only routers may bind config files")

        exec_cmds = node.get("exec")
        if exec_cmds is not None and role != "host":
            raise PolicyError(f"{where}: only hosts may have exec commands")
        exec_out = _validate_host_exec(exec_cmds, where)
        caps = _normalise_caps(node.get("cap-add"), role, where)

        limits = LIMITS[role]
        out_node: dict[str, Any] = {
            "kind": "linux",
            "image": image,
            "network-mode": "none",
            "privileged": False,
            "restart-policy": "no",
            "memory": f"{limits['memory'] // MIB}MiB",
            "cpu": limits["cpu_quota"] / CPU_PERIOD,
            "labels": {"breakfix.role": role},
        }
        if caps:
            out_node["cap-add"] = caps
        if binds_out:
            out_node["binds"] = binds_out
        if exec_out:
            out_node["exec"] = exec_out
        if role == "router":
            out_node["sysctls"] = dict(ROUTER_SYSCTLS)
        out_nodes[node_name] = out_node

    links_out: list[dict[str, Any]] = []
    links = topo.get("links") or []
    if not isinstance(links, list) or len(links) > MAX_LINKS:
        raise PolicyError(f"topology.links must be a list of at most {MAX_LINKS} links")
    used: set[str] = set()
    for i, link in enumerate(links):
        where = f"link {i}"
        if not isinstance(link, dict):
            raise PolicyError(f"{where}: must be a mapping")
        _only_keys(where, link, {"endpoints"})
        eps = link.get("endpoints")
        if not isinstance(eps, list) or len(eps) != 2 or not all(isinstance(e, str) for e in eps):
            raise PolicyError(f"{where}: endpoints must be two 'node:ethN' strings")
        for ep in eps:
            node_name, _, iface = ep.partition(":")
            if node_name not in out_nodes or not IFACE_RE.fullmatch(iface):
                raise PolicyError(f"{where}: bad endpoint {ep!r}")
            if ep in used:
                raise PolicyError(f"{where}: endpoint {ep!r} used twice")
            used.add(ep)
        links_out.append({"endpoints": list(eps)})

    topology = {
        "name": name,
        "prefix": CONTAINER_PREFIX,
        "mgmt": {"skip-when-unused": True},
        "topology": {"nodes": out_nodes, "links": links_out},
    }
    return LabPlan(name=name, topology=topology, config_dirs=config_dirs, roles=roles)


# ---------------------------------------------------------------------------------------------
# Container create (docker-guard, deploy socket used only by breakfix-clab -> containerlab)
# ---------------------------------------------------------------------------------------------

# Create-body keys that may carry a non-empty value. Anything else must be absent or empty.
_CREATE_KEYS = {
    "Hostname",
    "Domainname",
    "User",
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "Tty",
    "OpenStdin",
    "StdinOnce",
    "Env",
    "Image",
    "Labels",
    "StopSignal",
    "StopTimeout",
    "Healthcheck",
    "HostConfig",
    "NetworkingConfig",
    "ArgsEscaped",
}

# HostConfig keys that may carry a non-empty value. The security-relevant ones are overwritten.
_HOSTCONFIG_KEYS = {
    "Binds",
    "NetworkMode",
    "Sysctls",
    "CapAdd",
    "CapDrop",
    "Privileged",
    "SecurityOpt",
    "RestartPolicy",
    "Memory",
    "MemorySwap",
    "CpuQuota",
    "CpuPeriod",
    "NanoCpus",
    "PidsLimit",
    "Ulimits",
    "ExtraHosts",
    "Dns",
    "DnsSearch",
    "DnsOptions",
    "LogConfig",
    "ShmSize",
    "Init",
    "ConsoleSize",
    "CgroupnsMode",
    "IpcMode",
    "AutoRemove",
    "OomScoreAdj",
}


def _is_empty(value: Any) -> bool:
    return value in (None, "", 0, False) or value == [] or value == {}


def container_name_for(lab: str, node: str) -> str:
    return f"{CONTAINER_PREFIX}-{lab}-{node}"


def sanitize_create(
    name: str | None, body: object, images: ImagePolicy, labs_root: str
) -> tuple[dict[str, Any], str]:
    """Check a POST /containers/create body and return (hardened body, role).

    The caller still has to confirm that body["Image"] resolves to images.ids[role].
    """
    if not isinstance(body, dict):
        raise PolicyError("create body must be a JSON object")
    for key, value in body.items():
        if key not in _CREATE_KEYS and not _is_empty(value):
            raise PolicyError(f"create: field {key!r} not allowed")

    labels = body.get("Labels") or {}
    if not isinstance(labels, dict):
        raise PolicyError("create: Labels must be an object")
    lab = validate_lab_name(labels.get("containerlab"))
    node = labels.get("clab-node-name")
    if not isinstance(node, str) or not NODE_NAME_RE.fullmatch(node):
        raise PolicyError("create: missing or bad clab-node-name label")
    if name != container_name_for(lab, node):
        raise PolicyError(f"create: container name must be {container_name_for(lab, node)!r}")

    image = body.get("Image")
    role = images.role_for_ref(image) if isinstance(image, str) else None
    if role is None:
        raise PolicyError(f"create: image {image!r} is not an allowed lab image")
    if body.get("User") not in (None, "", "0", "root"):
        raise PolicyError("create: containers must not override the user")

    net = body.get("NetworkingConfig") or {}
    if not isinstance(net, dict) or any(not _is_empty(v) for v in net.values()):
        raise PolicyError("create: lab containers must not join a network")

    hc = body.get("HostConfig") or {}
    if not isinstance(hc, dict):
        raise PolicyError("create: HostConfig must be an object")
    for key, value in hc.items():
        if key not in _HOSTCONFIG_KEYS and not _is_empty(value):
            raise PolicyError(f"create: HostConfig.{key} not allowed")
    if hc.get("Privileged"):
        raise PolicyError("create: privileged containers are not allowed")
    if hc.get("NetworkMode") != "none":
        raise PolicyError("create: NetworkMode must be 'none'")
    if hc.get("IpcMode") not in (None, "", "private", "shareable"):
        raise PolicyError("create: IpcMode not allowed")
    if hc.get("CgroupnsMode") not in (None, "", "private"):
        raise PolicyError("create: CgroupnsMode not allowed")
    if hc.get("AutoRemove"):
        raise PolicyError("create: AutoRemove not allowed")
    shm = hc.get("ShmSize") or 0
    if not isinstance(shm, int) or shm > 64 * MIB:
        raise PolicyError("create: ShmSize too large")

    lab_files = posixpath.join(labs_root, lab, "files") + "/"
    binds = hc.get("Binds") or []
    if not isinstance(binds, list):
        raise PolicyError("create: Binds must be a list")
    if role == "router" and len(binds) != 1:
        raise PolicyError("create: a router needs exactly one config bind")
    if role != "router" and binds:
        raise PolicyError("create: only routers may have binds")
    for bind in binds:
        parts = bind.split(":") if isinstance(bind, str) else []
        if len(parts) not in (2, 3) or parts[1] != ROUTER_CONFIG_DIR or parts[2:] not in ([], ["rw"]):
            raise PolicyError(f"create: bind {bind!r} not allowed")
        src = parts[0]
        if (
            not src.startswith(lab_files)
            or posixpath.normpath(src) != src
            or not REL_PATH_RE.fullmatch(src[len(lab_files):])
        ):
            raise PolicyError(f"create: bind source {src!r} is outside the lab directory")

    sysctls = hc.get("Sysctls") or {}
    if not isinstance(sysctls, dict) or any(
        not isinstance(k, str) or not k.startswith("net.") or not isinstance(v, str)
        for k, v in sysctls.items()
    ):
        raise PolicyError("create: only net.* sysctls are allowed")

    caps = _normalise_caps(hc.get("CapAdd"), role, "create")

    ulimits = hc.get("Ulimits") or []
    if not isinstance(ulimits, list) or any(
        not isinstance(u, dict) or u.get("Name") != "nofile" for u in ulimits
    ):
        raise PolicyError("create: only the nofile ulimit may be set")

    log_config = hc.get("LogConfig") or {}
    if not isinstance(log_config, dict) or log_config.get("Type") not in (None, "", "json-file"):
        raise PolicyError("create: LogConfig type not allowed")

    limits = LIMITS[role]
    hardened_hc = dict(hc)
    hardened_hc.update(
        {
            "Privileged": False,
            "CapDrop": ["ALL"],
            "CapAdd": caps,
            "SecurityOpt": ["no-new-privileges"],
            "RestartPolicy": {"Name": "no"},
            "Memory": limits["memory"],
            "MemorySwap": limits["memory"],
            "CpuPeriod": CPU_PERIOD,
            "CpuQuota": limits["cpu_quota"],
            "NanoCpus": 0,
            "PidsLimit": limits["pids"],
            "AutoRemove": False,
        }
    )
    hardened = dict(body)
    hardened["HostConfig"] = hardened_hc
    hardened["Labels"] = {**labels, "breakfix.role": role}
    return hardened, role


# ---------------------------------------------------------------------------------------------
# Exec (docker-guard, app socket used by the server and tests)
# ---------------------------------------------------------------------------------------------

SHOW_RE = re.compile(r"^show [A-Za-z0-9 .:/_-]{1,200}$")
SAFE_ARG_RE = re.compile(r"^[A-Za-z0-9.:/_-]{1,64}$")
_EXEC_KEYS = {
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "Tty",
    "Cmd",
    "Env",
    "ConsoleSize",
    "DetachKeys",
    "Privileged",
    "User",
    "WorkingDir",
}
_IP_OBJECTS = {"addr", "address", "a", "route", "r", "link", "l", "neigh", "n"}


def _int_in(value: str, lo: int, hi: int) -> bool:
    return value.isdigit() and lo <= int(value) <= hi


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _check_flags(args: list[str], flags: dict[str, tuple[int, int] | None], what: str) -> str:
    """Parse '-x N' / '-y' flags then exactly one IP target. Returns the target."""
    i = 0
    while i < len(args) - 1:
        flag = args[i]
        if flag not in flags:
            raise PolicyError(f"{what}: option {flag!r} not allowed")
        bounds = flags[flag]
        if bounds is None:
            i += 1
            continue
        if i + 1 >= len(args) - 1 or not _int_in(args[i + 1], *bounds):
            raise PolicyError(f"{what}: {flag} needs a number from {bounds[0]} to {bounds[1]}")
        i += 2
    if i != len(args) - 1 or not _is_ip(args[-1]):
        raise PolicyError(f"{what}: the last argument must be one IP address")
    return args[-1]


def check_host_command(cmd: list[str]) -> None:
    """Allow read-only diagnostics on hosts: ping, traceroute, ip addr/route/link/neigh."""
    prog, args = cmd[0], cmd[1:]
    if any(not SAFE_ARG_RE.fullmatch(a) for a in args):
        raise PolicyError("host command: arguments contain characters that are not allowed")
    if prog == "ping":
        _check_flags(args, {"-c": (1, 10), "-W": (1, 5), "-s": (0, 1472), "-4": None, "-n": None}, "ping")
        if "-c" not in args:
            raise PolicyError("ping: -c COUNT is required")
    elif prog == "traceroute":
        _check_flags(args, {"-n": None, "-w": (1, 5), "-q": (1, 3), "-m": (1, 30)}, "traceroute")
    elif prog == "ip":
        rest = list(args)
        while rest and rest[0] in ("-j", "-4", "-6", "-br", "-d"):
            rest.pop(0)
        if not rest or rest[0] not in _IP_OBJECTS:
            raise PolicyError("ip: only addr, route, link and neigh may be shown")
        obj, rest = rest[0], rest[1:]
        if obj in ("route", "r") and rest[:1] == ["get"]:
            if len(rest) != 2 or not _is_ip(rest[1]):
                raise PolicyError("ip route get: needs exactly one IP address")
            return
        if rest[:1] in (["show"], ["list"]):
            rest = rest[1:]
        if rest and not (len(rest) == 2 and rest[0] == "dev" and IFACE_RE.fullmatch(rest[1])):
            raise PolicyError("ip: only 'show [dev ethN]' or 'route get IP' is allowed")
    else:
        raise PolicyError(f"host command {prog!r} not allowed")


def _is_show_batch(cmd: list[str]) -> bool:
    """vtysh -c "show ..." [-c "show ..."]... with 1-8 read-only show commands."""
    args = cmd[1:]
    if cmd[:1] != ["vtysh"] or not args or len(args) % 2 or len(args) > 16:
        return False
    return all(flag == "-c" and SHOW_RE.fullmatch(show) for flag, show in zip(args[::2], args[1::2]))


def sanitize_exec(role: str, body: object) -> dict[str, Any]:
    """Check a POST /containers/{id}/exec body and return the body to forward to Docker."""
    if not isinstance(body, dict):
        raise PolicyError("exec body must be a JSON object")
    extra = sorted(set(body) - _EXEC_KEYS)
    if extra:
        raise PolicyError(f"exec: field(s) not allowed: {', '.join(extra)}")
    if body.get("Privileged"):
        raise PolicyError("exec: privileged exec is not allowed")
    if body.get("User") not in (None, "", "0", "root"):
        raise PolicyError("exec: user override not allowed")
    if body.get("WorkingDir") not in (None, ""):
        raise PolicyError("exec: working directory override not allowed")
    cmd = body.get("Cmd")
    if (
        not isinstance(cmd, list)
        or not 1 <= len(cmd) <= 17
        or not all(isinstance(a, str) and 0 < len(a) <= 256 and "\x00" not in a for a in cmd)
    ):
        raise PolicyError("exec: Cmd must be a list of 1-16 non-empty strings")
    tty = bool(body.get("Tty"))

    if role == "router":
        if cmd == ["vtysh"]:
            pass
        elif not tty and _is_show_batch(cmd):
            pass
        else:
            raise PolicyError("exec: routers only allow 'vtysh' or 'vtysh -c \"show ...\"' (up to 8)")
        # The pager is a shell escape (more/less '!'); vtysh must never start one.
        env = ["VTYSH_PAGER=cat"]
        if tty:
            env.append("TERM=xterm-256color")
    elif role == "host":
        if tty:
            raise PolicyError("exec: hosts have no interactive terminal")
        check_host_command(cmd)
        env = []
    else:
        raise PolicyError("exec: unknown container role")

    out: dict[str, Any] = {
        "AttachStdin": bool(body.get("AttachStdin")) and role == "router" and cmd == ["vtysh"],
        "AttachStdout": bool(body.get("AttachStdout", True)),
        "AttachStderr": bool(body.get("AttachStderr", True)),
        "Tty": tty,
        "Cmd": cmd,
        "Env": env,
        "Privileged": False,
        "User": "",
        "WorkingDir": "",
    }
    size = body.get("ConsoleSize")
    if (
        isinstance(size, list)
        and len(size) == 2
        and all(isinstance(n, int) and 0 < n < 1000 for n in size)
    ):
        out["ConsoleSize"] = size
    return out
