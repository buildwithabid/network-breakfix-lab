"""Just enough HTTP/1.1 to sit between a Docker client and the Docker Engine API.

The guard never keeps connections alive: every forwarded request carries `Connection: close`, so a
response always ends when the upstream closes. The one exception is an upgrade (hijacked exec
stream), which is passed through untouched in both directions.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

MAX_HEAD = 64 * 1024
MAX_BODY = 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Request:
    method: str
    target: str
    version: str
    headers: list[tuple[str, str]] = field(default_factory=list)

    def header(self, name: str) -> str | None:
        lname = name.lower()
        for key, value in self.headers:
            if key.lower() == lname:
                return value
        return None

    @property
    def is_upgrade(self) -> bool:
        conn = (self.header("connection") or "").lower()
        return "upgrade" in conn and self.header("upgrade") is not None


@dataclass
class Response:
    status: int
    headers: list[tuple[str, str]]
    body: bytes
    raw: bytes

    def header(self, name: str) -> str | None:
        lname = name.lower()
        for key, value in self.headers:
            if key.lower() == lname:
                return value
        return None


async def read_head(reader: asyncio.StreamReader) -> bytes:
    try:
        return await reader.readuntil(b"\r\n\r\n")
    except asyncio.LimitOverrunError as exc:
        raise HttpError(431, "request head too large") from exc
    except asyncio.IncompleteReadError as exc:
        if exc.partial:
            raise HttpError(400, "incomplete request head") from exc
        raise EOFError from exc


def parse_request_head(raw: bytes) -> Request:
    try:
        text = raw.decode("latin-1")
    except UnicodeDecodeError as exc:  # pragma: no cover - latin-1 decodes any byte
        raise HttpError(400, "bad request head") from exc
    lines = text.split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        raise HttpError(400, "bad request line")
    method, target, version = parts
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep or not name or name != name.strip():
            raise HttpError(400, "bad header line")
        headers.append((name, value.strip()))
    return Request(method=method, target=target, version=version, headers=headers)


async def read_body(reader: asyncio.StreamReader, req: Request, limit: int = MAX_BODY) -> bytes:
    te = (req.header("transfer-encoding") or "").lower()
    if te:
        if te != "chunked":
            raise HttpError(501, "unsupported transfer-encoding")
        return await _read_chunked(reader, limit)
    length = req.header("content-length")
    if length is None:
        return b""
    if not length.isdigit():
        raise HttpError(400, "bad content-length")
    n = int(length)
    if n > limit:
        raise HttpError(413, "request body too large")
    return await reader.readexactly(n)


async def _read_chunked(reader: asyncio.StreamReader, limit: int) -> bytes:
    out = bytearray()
    while True:
        size_line = await reader.readuntil(b"\r\n")
        size_text = size_line.split(b";", 1)[0].strip()
        try:
            size = int(size_text, 16)
        except ValueError as exc:
            raise HttpError(400, "bad chunk size") from exc
        if size == 0:
            # trailers, if any, end with an empty line
            while (await reader.readuntil(b"\r\n")) != b"\r\n":
                pass
            return bytes(out)
        if len(out) + size > limit:
            raise HttpError(413, "request body too large")
        out += await reader.readexactly(size)
        if await reader.readexactly(2) != b"\r\n":
            raise HttpError(400, "bad chunk terminator")


def dechunk(data: bytes) -> bytes:
    out = bytearray()
    pos = 0
    while True:
        end = data.find(b"\r\n", pos)
        if end < 0:
            raise HttpError(502, "truncated chunked response")
        size = int(data[pos:end].split(b";", 1)[0].strip() or b"0", 16)
        pos = end + 2
        if size == 0:
            return bytes(out)
        out += data[pos : pos + size]
        pos += size + 2


def build_request(req: Request, body: bytes | None, *, keep_upgrade: bool = False) -> bytes:
    """Serialise a request for the upstream. Forces `Connection: close` unless it is an upgrade."""
    lines = [f"{req.method} {req.target} HTTP/1.1"]
    upgrade = keep_upgrade and req.is_upgrade
    for name, value in req.headers:
        lname = name.lower()
        if lname in ("connection", "keep-alive", "proxy-connection"):
            continue
        if body is not None and lname in ("content-length", "transfer-encoding"):
            continue
        if lname == "upgrade" and not upgrade:
            continue
        lines.append(f"{name}: {value}")
    lines.append("Connection: Upgrade" if upgrade else "Connection: close")
    if body is not None:
        lines.append(f"Content-Length: {len(body)}")
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")
    return head + (body or b"")


def simple_request(method: str, target: str, body: bytes | None = None) -> bytes:
    headers = [("Host", "docker")]
    if body is not None:
        headers.append(("Content-Type", "application/json"))
    return build_request(Request(method, target, "HTTP/1.1", headers), body)


def build_response(status: int, body: bytes, content_type: str = "application/json") -> bytes:
    reason = {
        200: "OK",
        201: "Created",
        400: "Bad Request",
        403: "Forbidden",
        404: "Not Found",
        413: "Payload Too Large",
        431: "Request Header Fields Too Large",
        500: "Internal Server Error",
        501: "Not Implemented",
        502: "Bad Gateway",
    }.get(status, "Error")
    head = (
        f"HTTP/1.1 {status} {reason}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    )
    return head.encode("latin-1") + body


def parse_response(raw: bytes) -> Response:
    head_end = raw.find(b"\r\n\r\n")
    if head_end < 0:
        raise HttpError(502, "bad upstream response")
    head = raw[:head_end].decode("latin-1")
    body = raw[head_end + 4 :]
    lines = head.split("\r\n")
    parts = lines[0].split(" ", 2)
    if len(parts) < 2 or not parts[1].isdigit():
        raise HttpError(502, "bad upstream status line")
    headers = []
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers.append((name, value.strip()))
    resp = Response(status=int(parts[1]), headers=headers, body=body, raw=raw)
    if (resp.header("transfer-encoding") or "").lower() == "chunked":
        resp.body = dechunk(body)
    return resp


async def read_to_eof(reader: asyncio.StreamReader, limit: int = MAX_RESPONSE) -> bytes:
    out = bytearray()
    while chunk := await reader.read(65536):
        out += chunk
        if len(out) > limit:
            raise HttpError(502, "upstream response too large")
    return bytes(out)


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Copy bytes until EOF, then half-close the writer."""
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except (OSError, RuntimeError):
            pass
