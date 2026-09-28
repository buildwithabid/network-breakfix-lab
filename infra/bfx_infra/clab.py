"""breakfix-clab: the only command the server (and the developer) may run as root, via sudo.

    breakfix-clab deploy <lab-source-dir>   validate, copy into a root-owned dir, deploy
    breakfix-clab destroy <lab-name>        destroy a bfx-* lab and remove its files
    breakfix-clab list                      JSON list of bfx-* labs

A plain sudoers rule for the containerlab binary would be root for anyone allowed to use it, because
a topology can bind-mount any host path. This wrapper never passes a caller's file to containerlab:
it validates the topology against bfx_infra.policy, copies only regular files (no symlinks) into
/var/lib/breakfix-clab/labs/<lab>/, writes a hardened topology there, and runs containerlab against
docker-guard's deploy socket so every container create is checked a second time.

Output is JSON on stdout. Exit codes: 0 ok, 2 refused by policy, 1 anything else.
"""

from __future__ import annotations

import contextlib
import fcntl
import http.client
import json
import os
import pwd
import shutil
import socket
import stat
import subprocess
import sys
import syslog
from typing import Any, Iterator
from urllib.parse import quote

import yaml

from .policy import (
    LAB_NAME_RE,
    MAX_CONFIG_BYTES,
    MAX_TOPOLOGY_BYTES,
    ROUTER_CONFIG_FILES,
    ROUTER_CONFIG_REQUIRED,
    ImagePolicy,
    PolicyError,
    validate_lab_name,
    validate_topology,
)

LABS_ROOT = "/var/lib/breakfix-clab/labs"
IMAGES_FILE = "/etc/breakfix/images.json"
DOCKER_SOCKET = "/run/docker.sock"
GUARD_DEPLOY_SOCKET = "/run/breakfix-guard/deploy.sock"
CONTAINERLAB = "/usr/bin/containerlab"
LOCK_FILE = "/run/lock/breakfix-clab.lock"
SSH_CONFIG_DIR = "/etc/ssh/ssh_config.d"
DEPLOY_TIMEOUT = 300


class Failure(Exception):
    """A runtime failure (not a policy refusal)."""


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 30) -> None:
        super().__init__("docker", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def docker(method: str, target: str) -> tuple[int, Any]:
    conn = _UnixHTTPConnection(DOCKER_SOCKET)
    try:
        conn.request(method, target, headers={"Host": "docker"})
        resp = conn.getresponse()
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)
    finally:
        conn.close()


def read_regular_file(path: str, limit: int) -> bytes:
    """Read a file without following symlinks; refuse anything that is not a small regular file."""
    name = os.path.basename(path)
    try:
        # O_NONBLOCK: opening a FIFO must not wait for a writer.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as exc:
        raise PolicyError(f"cannot open {name!r}: {exc.strerror}") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise PolicyError(f"{name!r} is not a regular file")
        if st.st_size > limit:
            raise PolicyError(f"{name!r} is larger than {limit} bytes")
        chunks = []
        remaining = limit + 1
        while remaining > 0 and (chunk := os.read(fd, min(remaining, 65536))):
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise PolicyError(f"{name!r} is larger than {limit} bytes")
        return data
    finally:
        os.close(fd)


def read_config_dir(src: str, rel_dir: str) -> dict[str, bytes]:
    """Read a router's config files from src/rel_dir. The directory must be real, not a symlink."""
    path = os.path.join(src, rel_dir)
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise PolicyError(f"config directory {rel_dir!r} does not exist") from exc
    if not stat.S_ISDIR(st.st_mode):
        raise PolicyError(f"config directory {rel_dir!r} is not a directory")
    if os.path.realpath(path) != os.path.join(os.path.realpath(src), rel_dir):
        raise PolicyError(f"config directory {rel_dir!r} leaves the lab directory")
    files: dict[str, bytes] = {}
    for name in ROUTER_CONFIG_FILES:
        file_path = os.path.join(path, name)
        if os.path.lexists(file_path):
            files[name] = read_regular_file(file_path, MAX_CONFIG_BYTES)
        elif name in ROUTER_CONFIG_REQUIRED:
            raise PolicyError(f"{rel_dir}/{name} is missing")
    return files


def remap_ids() -> tuple[int, int]:
    """Host uid/gid that is root inside containers (Docker userns-remap), or 0/0 without it."""

    def first_id(path: str) -> int:
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    name, _, rest = line.strip().partition(":")
                    if name == "dockremap":
                        return int(rest.split(":")[0])
        except FileNotFoundError:
            pass
        return 0

    return first_id("/etc/subuid"), first_id("/etc/subgid")


def load_images() -> ImagePolicy:
    with open(IMAGES_FILE, encoding="utf-8") as fh:
        return ImagePolicy.from_json(fh.read())


@contextlib.contextmanager
def global_lock() -> Iterator[None]:
    with open(LOCK_FILE, "a", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def lab_dir_for(name: str) -> str:
    validate_lab_name(name)
    path = os.path.join(LABS_ROOT, name)
    if os.path.dirname(path) != LABS_ROOT:
        raise PolicyError("bad lab path")
    return path


def audit(action: str, detail: str) -> None:
    caller = os.environ.get("SUDO_USER") or pwd.getpwuid(os.getuid()).pw_name
    syslog.syslog(syslog.LOG_NOTICE, f"user={caller} action={action} {detail}")


def lab_containers(name: str) -> list[dict[str, Any]]:
    filters = json.dumps({"label": [f"containerlab={name}"]})
    status, data = docker("GET", f"/containers/json?all=1&filters={quote(filters)}")
    if status != 200:
        raise Failure(f"docker list failed ({status})")
    return data or []


def run_containerlab(args: list[str], cwd: str) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "DOCKER_HOST": f"unix://{GUARD_DEPLOY_SOCKET}",
        "CLAB_VERSION_CHECK": "disable",
    }
    return subprocess.run(
        [CONTAINERLAB, *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=DEPLOY_TIMEOUT,
        check=False,
    )


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------


def verify(name: str, roles: dict[str, str]) -> list[dict[str, Any]]:
    """Read back every container and confirm the hardening actually applied."""
    nodes = []
    containers = lab_containers(name)
    if len(containers) != len(roles):
        raise Failure(f"expected {len(roles)} containers, found {len(containers)}")
    for c in containers:
        status, info = docker("GET", f"/containers/{c['Id']}/json")
        if status != 200:
            raise Failure("inspect failed")
        hc = info["HostConfig"]
        node = info["Config"]["Labels"].get("clab-node-name")
        problems = []
        if hc.get("Privileged"):
            problems.append("privileged")
        if hc.get("CapDrop") != ["ALL"]:
            problems.append("CapDrop is not ALL")
        if hc.get("NetworkMode") != "none":
            problems.append("has a network")
        if not hc.get("PidsLimit") or not hc.get("Memory"):
            problems.append("missing limits")
        if "no-new-privileges" not in (hc.get("SecurityOpt") or []):
            problems.append("no-new-privileges missing")
        if problems:
            raise Failure(f"node {node}: {', '.join(problems)}")
        nodes.append({"node": node, "container": info["Name"].lstrip("/"), "role": roles.get(node)})
    return sorted(nodes, key=lambda n: n["node"])


def destroy_lab(name: str) -> None:
    lab_dir = lab_dir_for(name)
    topo = os.path.join(lab_dir, "topology.clab.yml")
    if os.path.isfile(topo) and not os.path.islink(topo):
        run_containerlab(["destroy", "-t", topo, "--cleanup", "--log-level", "warn"], lab_dir)
    for c in lab_containers(name):  # anything containerlab left behind
        docker("DELETE", f"/containers/{c['Id']}?force=1&v=1")
    if lab_containers(name):
        raise Failure(f"containers of {name} are still present")
    if os.path.lexists(lab_dir):
        if os.path.islink(lab_dir):
            os.unlink(lab_dir)
        else:
            shutil.rmtree(lab_dir)
    with contextlib.suppress(FileNotFoundError):
        os.unlink(os.path.join(SSH_CONFIG_DIR, f"clab-{name}.conf"))


def write_lab_files(lab_dir: str, topology: dict[str, Any], configs: dict[str, dict[str, bytes]]) -> None:
    uid, gid = remap_ids()
    os.makedirs(os.path.join(lab_dir, "files"), mode=0o711)
    os.chmod(lab_dir, 0o711)
    for rel, files in configs.items():
        # The config dir belongs to the container's root so FRR can save (`write memory`).
        dest_dir = os.path.join(lab_dir, "files", rel)
        os.makedirs(os.path.dirname(dest_dir), mode=0o711, exist_ok=True)
        os.mkdir(dest_dir, 0o755)
        os.chown(dest_dir, uid, gid)
        for fname, data in files.items():
            dest = os.path.join(dest_dir, fname)
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.chown(dest, uid, gid)
    topo_path = os.path.join(lab_dir, "topology.clab.yml")
    fd = os.open(topo_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        yaml.safe_dump(topology, fh, sort_keys=False)


def cmd_deploy(src_arg: str) -> dict[str, Any]:
    src = os.path.realpath(src_arg)
    if not os.path.isdir(src):
        raise PolicyError("lab source must be a directory")
    raw = read_regular_file(os.path.join(src, "topology.clab.yml"), MAX_TOPOLOGY_BYTES)
    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise PolicyError("topology.clab.yml is not valid YAML") from exc
    name = validate_lab_name(doc.get("name") if isinstance(doc, dict) else None)
    lab_dir = lab_dir_for(name)
    plan = validate_topology(doc, load_images(), lab_dir)
    configs = {rel: read_config_dir(src, rel) for rel in plan.config_dirs.values()}

    with global_lock():
        if os.path.lexists(lab_dir) or lab_containers(name):
            raise PolicyError(f"lab {name} already exists")
        audit("deploy", f"lab={name} src={src}")
        try:
            write_lab_files(lab_dir, plan.topology, configs)
            proc = run_containerlab(["deploy", "-t", "topology.clab.yml", "--log-level", "warn"], lab_dir)
            if proc.returncode != 0:
                tail = (proc.stderr or proc.stdout).strip().splitlines()[-15:]
                raise Failure("containerlab deploy failed:\n" + "\n".join(tail))
            with contextlib.suppress(FileNotFoundError):
                os.unlink(os.path.join(SSH_CONFIG_DIR, f"clab-{name}.conf"))
            nodes = verify(name, plan.roles)
        except BaseException:
            destroy_lab(name)
            raise
    return {"lab": name, "nodes": nodes}


def cmd_destroy(name: str) -> dict[str, Any]:
    validate_lab_name(name)
    with global_lock():
        audit("destroy", f"lab={name}")
        destroy_lab(name)
    return {"lab": name, "destroyed": True}


def cmd_list() -> list[dict[str, Any]]:
    status, data = docker(
        "GET", "/containers/json?all=1&filters=" + quote(json.dumps({"label": ["containerlab"]}))
    )
    if status != 200:
        raise Failure(f"docker list failed ({status})")
    labs: dict[str, dict[str, Any]] = {}
    for c in data or []:
        name = (c.get("Labels") or {}).get("containerlab", "")
        if not LAB_NAME_RE.fullmatch(name):
            continue
        lab = labs.setdefault(name, {"lab": name, "created": c["Created"], "nodes": []})
        lab["created"] = min(lab["created"], c["Created"])
        lab["nodes"].append(
            {
                "node": c["Labels"].get("clab-node-name"),
                "container": c["Names"][0].lstrip("/"),
                "state": c["State"],
            }
        )
    if os.path.isdir(LABS_ROOT):
        for entry in os.listdir(LABS_ROOT):
            if LAB_NAME_RE.fullmatch(entry) and entry not in labs:
                created = int(os.lstat(os.path.join(LABS_ROOT, entry)).st_mtime)
                labs[entry] = {"lab": entry, "created": created, "nodes": []}
    return sorted(labs.values(), key=lambda lab: lab["lab"])


USAGE = "usage: breakfix-clab deploy <lab-source-dir> | destroy <lab-name> | list"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    syslog.openlog("breakfix-clab", 0, syslog.LOG_AUTH)
    if os.geteuid() != 0:
        print(json.dumps({"error": "breakfix-clab must run as root (use sudo)"}))
        return 1
    try:
        if len(args) == 2 and args[0] == "deploy":
            result: Any = cmd_deploy(args[1])
        elif len(args) == 2 and args[0] == "destroy":
            result = cmd_destroy(args[1])
        elif args == ["list"]:
            result = cmd_list()
        else:
            print(json.dumps({"error": USAGE}))
            return 1
    except PolicyError as exc:
        audit("refused", str(exc).replace("\n", " "))
        print(json.dumps({"error": str(exc), "refused": True}))
        return 2
    except (Failure, OSError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0
