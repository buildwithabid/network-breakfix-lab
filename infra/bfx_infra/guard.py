"""docker-guard: a policy-enforcing proxy in front of the Docker Engine API.

Two unix sockets, two profiles:

* app.sock (group `breakfix`, mode 0660): used by the server and the test suite. Allows only
  listing and inspecting lab containers (`bfx-*`), creating execs that pass sanitize_exec(), and
  starting/resizing/inspecting those execs. Everything else is refused with 403.
* deploy.sock (owner only, mode 0600): used by breakfix-clab when it runs containerlab as root.
  Every container create is checked and hardened by sanitize_create() (CapDrop=ALL, no privileged,
  limits, pinned image ID); a few dangerous endpoints are refused; the rest passes through.

Access to the Docker socket is root-equivalent. The point of this proxy is that the server, which
faces the internet, never holds that access, and containerlab cannot create a container outside
the policy even if a topology slipped past validation.
"""

from __future__ import annotations

import argparse
import asyncio
import grp
import json
import os
import re
import signal
import stat
import sys
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, quote, urlencode

from .httpio import (
    MAX_HEAD,
    HttpError,
    Request,
    Response,
    build_request,
    build_response,
    parse_request_head,
    parse_response,
    pipe,
    read_body,
    read_head,
    read_to_eof,
    simple_request,
)
from .policy import LAB_NAME_RE, ImagePolicy, PolicyError, sanitize_create, sanitize_exec

APP_SOCKET = "/run/breakfix-guard/app.sock"
DEPLOY_SOCKET = "/run/breakfix-guard/deploy.sock"
DOCKER_SOCKET = "/run/docker.sock"
IMAGES_FILE = "/etc/breakfix/images.json"
LABS_ROOT = "/var/lib/breakfix-clab/labs"
APP_GROUP = "breakfix"

EXEC_TTL_SECONDS = 24 * 3600
VERSION_PREFIX_RE = re.compile(r"^/v1\.[0-9]{1,3}(?=/)")
IDENT = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"
EXEC_ID = r"[0-9a-f]{64}"

# Deploy-profile endpoints that containerlab never needs for `linux` nodes.
DEPLOY_DENY = [
    re.compile(p)
    for p in (
        r"^/containers/[^/]+/update$",
        r"^/containers/[^/]+/archive$",
        r"^/commit$",
        r"^/build(/.*)?$",
        r"^/images/(create|load)$",
        r"^/(plugins|swarm|services|secrets|configs|nodes|tasks|session|grpc|distribution)(/.*)?$",
        r"^/volumes/create$",
    )
]


def log(**fields: Any) -> None:
    fields = {"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), **fields}
    print(json.dumps(fields, separators=(",", ":")), file=sys.stderr, flush=True)


def json_error(status: int, message: str) -> bytes:
    return build_response(status, json.dumps({"message": message}).encode())


class Guard:
    def __init__(self, docker_socket: str, images: ImagePolicy, labs_root: str) -> None:
        self.docker_socket = docker_socket
        self.images = images
        self.labs_root = labs_root
        self.execs: dict[str, tuple[float, str]] = {}

    # -- upstream helpers ------------------------------------------------------------------

    async def _upstream(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        try:
            return await asyncio.open_unix_connection(self.docker_socket, limit=MAX_HEAD)
        except OSError as exc:
            raise HttpError(502, f"docker is not reachable: {exc.strerror}") from exc

    async def call(self, method: str, target: str, body: bytes | None = None) -> Response:
        reader, writer = await self._upstream()
        try:
            writer.write(simple_request(method, target, body))
            await writer.drain()
            return parse_response(await read_to_eof(reader))
        finally:
            writer.close()

    async def passthrough(
        self, req: Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Forward the request as-is and splice both directions (covers hijacked exec streams)."""
        up_reader, up_writer = await self._upstream()
        up_writer.write(build_request(req, None, keep_upgrade=True))
        await up_writer.drain()
        to_upstream = asyncio.create_task(pipe(reader, up_writer))
        try:
            await pipe(up_reader, writer)
        finally:
            to_upstream.cancel()
            up_writer.close()

    async def lab_container(self, ident: str) -> dict[str, Any] | None:
        resp = await self.call("GET", f"/containers/{quote(ident)}/json")
        if resp.status != 200:
            return None
        info = json.loads(resp.body)
        labels = (info.get("Config") or {}).get("Labels") or {}
        lab = labels.get("containerlab")
        if not isinstance(lab, str) or not LAB_NAME_RE.fullmatch(lab):
            return None
        return info

    def role_of(self, info: dict[str, Any]) -> str | None:
        for role, image_id in self.images.ids.items():
            if info.get("Image") == image_id:
                return role
        return None

    def _prune_execs(self) -> None:
        now = time.monotonic()
        for exec_id in [k for k, (expiry, _) in self.execs.items() if expiry < now]:
            del self.execs[exec_id]

    # -- connection handling ---------------------------------------------------------------

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, profile: str
    ) -> None:
        req: Request | None = None
        path = ""
        try:
            req = parse_request_head(await read_head(reader))
            raw_path, _, query = req.target.partition("?")
            match = VERSION_PREFIX_RE.match(raw_path)
            path = raw_path[match.end() :] if match else raw_path
            if not path.startswith("/") or "%" in path or "//" in path or "/.." in path:
                raise HttpError(400, "bad path")
            if profile == "app":
                status = await self.handle_app(req, path, query, reader, writer)
            else:
                status = await self.handle_deploy(req, path, query, reader, writer)
            log(profile=profile, method=req.method, path=path, status=status)
        except EOFError:
            pass
        except PolicyError as exc:
            writer.write(json_error(403, f"docker-guard: {exc}"))
            log(profile=profile, method=getattr(req, "method", "?"), path=path, status=403, reason=str(exc))
        except HttpError as exc:
            writer.write(json_error(exc.status, f"docker-guard: {exc.message}"))
            log(profile=profile, method=getattr(req, "method", "?"), path=path, status=exc.status, reason=exc.message)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as exc:  # noqa: BLE001 - last-resort guard, logged
            writer.write(json_error(500, "docker-guard: internal error"))
            log(profile=profile, path=path, status=500, reason=repr(exc))
        finally:
            try:
                await writer.drain()
            except (ConnectionError, RuntimeError):
                pass
            writer.close()

    async def handle_app(
        self,
        req: Request,
        path: str,
        query: str,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> int:
        method = req.method

        if (method in ("GET", "HEAD") and path == "/_ping") or (method == "GET" and path == "/version"):
            await self.passthrough(req, reader, writer)
            return 200

        if method == "GET" and path == "/containers/json":
            return await self.list_containers(query, writer)

        if (m := re.fullmatch(rf"/containers/({IDENT})/json", path)) and method == "GET":
            info = await self.lab_container(m.group(1))
            if info is None:
                raise HttpError(404, "no such lab container")
            writer.write(build_response(200, json.dumps(info).encode()))
            return 200

        if (m := re.fullmatch(rf"/containers/({IDENT})/exec", path)) and method == "POST":
            info = await self.lab_container(m.group(1))
            if info is None:
                raise HttpError(404, "no such lab container")
            role = self.role_of(info)
            if role is None:
                raise PolicyError("container does not run a lab image")
            try:
                body = json.loads(await read_body(reader, req) or b"{}")
            except json.JSONDecodeError as exc:
                raise HttpError(400, "exec body is not JSON") from exc
            clean = sanitize_exec(role, body)
            resp = await self.call(
                "POST", f"/containers/{info['Id']}/exec", json.dumps(clean).encode()
            )
            if resp.status == 201:
                self._prune_execs()
                exec_id = json.loads(resp.body)["Id"]
                self.execs[exec_id] = (time.monotonic() + EXEC_TTL_SECONDS, role)
            writer.write(build_response(resp.status, resp.body))
            return resp.status

        if m := re.fullmatch(rf"/exec/({EXEC_ID})/(start|resize|json)", path):
            action = m.group(2)
            expected = "GET" if action == "json" else "POST"
            if method != expected or m.group(1) not in self.execs:
                raise PolicyError("unknown exec")
            await self.passthrough(req, reader, writer)
            return 200

        raise PolicyError(f"{method} {path} is not allowed")

    async def list_containers(self, query: str, writer: asyncio.StreamWriter) -> int:
        params = parse_qs(query)
        filters: dict[str, Any] = {}
        if "filters" in params:
            try:
                filters = json.loads(params["filters"][0])
            except json.JSONDecodeError as exc:
                raise HttpError(400, "bad filters") from exc
            if not isinstance(filters, dict) or set(filters) - {"label", "name", "status", "id"}:
                raise PolicyError("only label, name, status and id filters are allowed")
        labels = filters.get("label", [])
        if isinstance(labels, dict):  # the legacy {"label": {"k=v": true}} form
            labels = [k for k, v in labels.items() if v]
        filters["label"] = ["containerlab", *labels]
        all_flag = "1" if params.get("all", ["0"])[0] in ("1", "true") else "0"
        resp = await self.call(
            "GET", "/containers/json?" + urlencode({"all": all_flag, "filters": json.dumps(filters)})
        )
        if resp.status != 200:
            writer.write(build_response(resp.status, resp.body))
            return resp.status
        items = [
            c
            for c in json.loads(resp.body)
            if LAB_NAME_RE.fullmatch(str((c.get("Labels") or {}).get("containerlab", "")))
        ]
        writer.write(build_response(200, json.dumps(items).encode()))
        return 200

    async def handle_deploy(
        self,
        req: Request,
        path: str,
        query: str,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> int:
        if any(p.fullmatch(path) for p in DEPLOY_DENY):
            raise PolicyError(f"{req.method} {path} is not allowed for lab deployment")

        if req.method == "POST" and path == "/containers/create":
            try:
                body = json.loads(await read_body(reader, req) or b"{}")
            except json.JSONDecodeError as exc:
                raise HttpError(400, "create body is not JSON") from exc
            name = parse_qs(query).get("name", [None])[0]
            clean, role = sanitize_create(name, body, self.images, self.labs_root)
            image = await self.call("GET", f"/images/{quote(clean['Image'], safe='/:@')}/json")
            if image.status != 200 or json.loads(image.body).get("Id") != self.images.ids[role]:
                raise PolicyError(f"image {clean['Image']!r} does not match the pinned image ID")
            resp = await self.call(
                "POST", f"/containers/create?{query}", json.dumps(clean).encode()
            )
            writer.write(build_response(resp.status, resp.body))
            return resp.status

        if req.method == "POST" and re.fullmatch(rf"/containers/({IDENT})/exec", path):
            try:
                body = json.loads(await read_body(reader, req) or b"{}")
            except json.JSONDecodeError as exc:
                raise HttpError(400, "exec body is not JSON") from exc
            if not isinstance(body, dict) or body.get("Privileged"):
                raise PolicyError("privileged exec is not allowed")
            resp = await self.call("POST", path, json.dumps(body).encode())
            writer.write(build_response(resp.status, resp.body))
            return resp.status

        await self.passthrough(req, reader, writer)
        return 200


def _prepare_socket_path(path: str) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode):
        raise SystemExit(f"{path} exists and is not a socket")
    os.unlink(path)


async def serve(args: argparse.Namespace) -> None:
    with open(args.images, encoding="utf-8") as fh:
        images = ImagePolicy.from_json(fh.read())
    guard = Guard(args.docker_socket, images, args.labs_root)

    _prepare_socket_path(args.app_socket)
    _prepare_socket_path(args.deploy_socket)
    old_umask = os.umask(0o077)
    try:
        app = await asyncio.start_unix_server(
            lambda r, w: guard.handle(r, w, "app"), path=args.app_socket, limit=MAX_HEAD
        )
        deploy = await asyncio.start_unix_server(
            lambda r, w: guard.handle(r, w, "deploy"), path=args.deploy_socket, limit=MAX_HEAD
        )
    finally:
        os.umask(old_umask)
    if args.app_group:
        os.chown(args.app_socket, -1, grp.getgrnam(args.app_group).gr_gid)
    os.chmod(args.app_socket, 0o660)
    os.chmod(args.deploy_socket, 0o600)
    log(event="listening", app=args.app_socket, deploy=args.deploy_socket)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with app, deploy:
        await stop.wait()
    log(event="stopped")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="breakfix-docker-guard")
    parser.add_argument("--app-socket", default=APP_SOCKET)
    parser.add_argument("--deploy-socket", default=DEPLOY_SOCKET)
    parser.add_argument("--docker-socket", default=DOCKER_SOCKET)
    parser.add_argument("--images", default=IMAGES_FILE)
    parser.add_argument("--labs-root", default=LABS_ROOT)
    parser.add_argument("--app-group", default=APP_GROUP, help="empty string = leave group as is")
    asyncio.run(serve(parser.parse_args(argv)))
    return 0
