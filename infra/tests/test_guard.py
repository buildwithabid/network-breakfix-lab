"""docker-guard against a fake Docker Engine: routing, policy and stream pass-through."""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import unittest
from typing import Any
from unittest import mock

from bfx_infra.guard import Guard
from bfx_infra.httpio import build_response, parse_request_head, parse_response, read_body, read_head
from bfx_infra.policy import ImagePolicy

FRR = "quay.io/frrouting/frr:10.7.1"
HOST = "breakfix-host:0.1.0"
ROUTER_ID = "sha256:" + "a" * 64
HOST_ID = "sha256:" + "b" * 64
IMAGES = ImagePolicy(refs={"router": FRR, "host": HOST}, ids={"router": ROUTER_ID, "host": HOST_ID})
LABS = "/var/lib/breakfix-clab/labs"
EXEC_ID = "e" * 64

CONTAINERS = {
    "clab-bfx-t-demo-r1": {
        "Id": "c1" * 32,
        "Image": ROUTER_ID,
        "Config": {"Labels": {"containerlab": "bfx-t-demo", "clab-node-name": "r1"}},
    },
    "clab-bfx-t-demo-h1": {
        "Id": "c2" * 32,
        "Image": HOST_ID,
        "Config": {"Labels": {"containerlab": "bfx-t-demo", "clab-node-name": "h1"}},
    },
    "unrelated": {"Id": "c3" * 32, "Image": ROUTER_ID, "Config": {"Labels": {"app": "prod"}}},
}


class FakeDocker:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, Any]] = []

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        req = parse_request_head(await read_head(reader))
        raw_body = await read_body(reader, req)
        body = json.loads(raw_body) if raw_body else None
        self.requests.append((req.method, req.target, body))
        path = re.sub(r"^/v1\.[0-9]+", "", req.target.split("?")[0])
        if req.method == "POST" and path == f"/exec/{EXEC_ID}/start" and req.is_upgrade:
            writer.write(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
            await writer.drain()
            while data := await reader.read(1024):  # echo the "terminal"
                writer.write(data.upper())
                await writer.drain()
            writer.close()
            return
        status, out = 200, {"passthrough": path}
        if path == "/containers/json":
            out = [
                {"Id": c["Id"], "Labels": c["Config"]["Labels"], "Names": [f"/{n}"]}
                for n, c in CONTAINERS.items()
            ]
        elif path.startswith("/containers/") and path.endswith("/json") and req.method == "GET":
            ident = path.split("/")[2]
            info = CONTAINERS.get(ident) or next(
                (c for c in CONTAINERS.values() if c["Id"] == ident), None
            )
            status, out = (200, info) if info else (404, {"message": "no such container"})
        elif path.endswith("/exec") and req.method == "POST":
            status, out = 201, {"Id": EXEC_ID}
        elif path.startswith("/images/"):
            ref = path[len("/images/") : -len("/json")]
            status, out = (200, {"Id": ROUTER_ID if ref == FRR else HOST_ID}) if ref in (FRR, HOST) else (404, {})
        elif path == "/containers/create":
            status, out = 201, {"Id": "new"}
        writer.write(build_response(status, json.dumps(out).encode()))
        await writer.drain()
        writer.close()


class GuardTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        log_patch = mock.patch("bfx_infra.guard.log")
        log_patch.start()
        self.addCleanup(log_patch.stop)
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.docker_sock = os.path.join(d, "docker.sock")
        self.app_sock = os.path.join(d, "app.sock")
        self.deploy_sock = os.path.join(d, "deploy.sock")
        self.fake = FakeDocker()
        self.servers = [await asyncio.start_unix_server(self.fake.handle, path=self.docker_sock)]
        self.guard = Guard(self.docker_sock, IMAGES, LABS)
        self.servers.append(
            await asyncio.start_unix_server(lambda r, w: self.guard.handle(r, w, "app"), path=self.app_sock)
        )
        self.servers.append(
            await asyncio.start_unix_server(
                lambda r, w: self.guard.handle(r, w, "deploy"), path=self.deploy_sock
            )
        )

    async def asyncTearDown(self) -> None:
        for server in self.servers:
            server.close()
            await server.wait_closed()
        self.tmp.cleanup()

    async def request(self, sock: str, method: str, target: str, body: Any = None) -> tuple[int, Any]:
        reader, writer = await asyncio.open_unix_connection(sock)
        data = json.dumps(body).encode() if body is not None else b""
        head = f"{method} {target} HTTP/1.1\r\nHost: docker\r\nContent-Length: {len(data)}\r\n\r\n"
        writer.write(head.encode() + data)
        await writer.drain()
        raw = await reader.read(-1)
        writer.close()
        resp = parse_response(raw)
        return resp.status, (json.loads(resp.body) if resp.body else None)

    def forwarded(self, method: str, path_prefix: str) -> list[Any]:
        return [b for m, t, b in self.fake.requests if m == method and t.startswith(path_prefix)]

    # -- app profile --------------------------------------------------------------------------

    async def test_router_exec_is_sanitised_and_forwarded(self) -> None:
        status, body = await self.request(
            self.app_sock,
            "POST",
            "/v1.47/containers/clab-bfx-t-demo-r1/exec",
            {"Cmd": ["vtysh"], "Tty": True, "AttachStdin": True, "Env": ["VTYSH_PAGER=less"]},
        )
        self.assertEqual(status, 201)
        self.assertEqual(body["Id"], EXEC_ID)
        sent = self.forwarded("POST", f"/containers/{'c1' * 32}/exec")[0]
        self.assertEqual(sent["Env"], ["VTYSH_PAGER=cat"])
        self.assertEqual(sent["Cmd"], ["vtysh"])

    async def test_shell_exec_is_refused_and_never_reaches_docker(self) -> None:
        for cmd in (["sh"], ["vtysh", "-c", "start-shell"]):
            status, body = await self.request(
                self.app_sock, "POST", "/containers/clab-bfx-t-demo-r1/exec", {"Cmd": cmd}
            )
            self.assertEqual(status, 403, cmd)
            self.assertIn("docker-guard", body["message"])
        self.assertEqual(self.forwarded("POST", "/containers/"), [])

    async def test_hijacked_exec_stream_passes_through(self) -> None:
        await self.request(self.app_sock, "POST", "/containers/clab-bfx-t-demo-r1/exec", {"Cmd": ["vtysh"], "Tty": True})
        reader, writer = await asyncio.open_unix_connection(self.app_sock)
        start = json.dumps({"Detach": False, "Tty": True}).encode()
        writer.write(
            (
                f"POST /v1.47/exec/{EXEC_ID}/start HTTP/1.1\r\nHost: docker\r\n"
                f"Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(start)}\r\n\r\n"
            ).encode()
            + start
        )
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        self.assertTrue(head.startswith(b"HTTP/1.1 101"))
        writer.write(b"show version\r")
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(13), 2), b"SHOW VERSION\r")
        writer.close()

    async def test_unknown_exec_ids_are_refused(self) -> None:
        for action, method in (("start", "POST"), ("resize", "POST"), ("json", "GET")):
            status, _ = await self.request(self.app_sock, method, f"/exec/{'f' * 64}/{action}")
            self.assertEqual(status, 403)

    async def test_list_only_shows_lab_containers(self) -> None:
        status, body = await self.request(self.app_sock, "GET", "/v1.47/containers/json?all=1")
        self.assertEqual(status, 200)
        self.assertEqual(sorted(c["Names"][0] for c in body), ["/clab-bfx-t-demo-h1", "/clab-bfx-t-demo-r1"])
        target = [t for m, t, _ in self.fake.requests if t.startswith("/containers/json")][0]
        self.assertIn("containerlab", target)

    async def test_non_lab_containers_look_absent(self) -> None:
        status, _ = await self.request(self.app_sock, "GET", "/containers/unrelated/json")
        self.assertEqual(status, 404)
        status, _ = await self.request(self.app_sock, "POST", "/containers/unrelated/exec", {"Cmd": ["vtysh"]})
        self.assertEqual(status, 404)

    async def test_everything_else_is_forbidden_on_the_app_socket(self) -> None:
        for method, target in (
            ("POST", "/containers/create?name=x"),
            ("DELETE", "/containers/clab-bfx-t-demo-r1"),
            ("POST", "/containers/clab-bfx-t-demo-r1/stop"),
            ("GET", "/images/json"),
            ("POST", "/images/create?fromImage=alpine"),
            ("GET", "/info"),
            ("POST", "/build"),
            ("GET", "/containers/clab-bfx-t-demo-r1/archive?path=/etc"),
        ):
            status, _ = await self.request(self.app_sock, method, target)
            self.assertEqual(status, 403, target)
        self.assertEqual([t for m, t, _ in self.fake.requests if not t.startswith("/containers/")], [])

    async def test_encoded_or_traversing_paths_are_rejected(self) -> None:
        for target in ("/containers/..%2f/json", "/v1.47/../info", "/containers//json"):
            status, _ = await self.request(self.app_sock, "GET", target)
            self.assertIn(status, (400, 403), target)

    # -- deploy profile -----------------------------------------------------------------------

    def create_body(self, **hc: Any) -> dict[str, Any]:
        host_config = {"NetworkMode": "none", "CapAdd": ["NET_ADMIN"], **hc}
        return {
            "Image": FRR,
            "Labels": {"containerlab": "bfx-t-demo", "clab-node-name": "r1"},
            "HostConfig": host_config,
        }

    async def test_create_is_hardened(self) -> None:
        status, _ = await self.request(
            self.deploy_sock, "POST", "/v1.47/containers/create?name=clab-bfx-t-demo-r1", self.create_body()
        )
        self.assertEqual(status, 201)
        sent = self.forwarded("POST", "/containers/create")[0]
        self.assertEqual(sent["HostConfig"]["CapDrop"], ["ALL"])
        self.assertEqual(sent["HostConfig"]["PidsLimit"], 256)

    async def test_privileged_create_is_refused(self) -> None:
        status, _ = await self.request(
            self.deploy_sock,
            "POST",
            "/containers/create?name=clab-bfx-t-demo-r1",
            self.create_body(Privileged=True),
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.forwarded("POST", "/containers/create"), [])

    async def test_image_id_must_match_the_pin(self) -> None:
        self.guard.images = ImagePolicy(refs=IMAGES.refs, ids={"router": "sha256:" + "9" * 64, "host": HOST_ID})
        status, body = await self.request(
            self.deploy_sock, "POST", "/containers/create?name=clab-bfx-t-demo-r1", self.create_body()
        )
        self.assertEqual(status, 403)
        self.assertIn("pinned image", body["message"])

    async def test_deploy_denylist_and_passthrough(self) -> None:
        status, _ = await self.request(self.deploy_sock, "POST", "/containers/x/update", {"Memory": 1})
        self.assertEqual(status, 403)
        status, _ = await self.request(self.deploy_sock, "POST", "/images/create?fromImage=evil")
        self.assertEqual(status, 403)
        status, _ = await self.request(
            self.deploy_sock, "POST", "/containers/x/exec", {"Cmd": ["sh"], "Privileged": True}
        )
        self.assertEqual(status, 403)
        status, body = await self.request(self.deploy_sock, "GET", "/v1.47/info")
        self.assertEqual((status, body), (200, {"passthrough": "/info"}))
        self.assertIn(("GET", "/v1.47/info", None), self.fake.requests)


if __name__ == "__main__":
    unittest.main()
