"""Unit tests for bfx_infra.policy. Run: python3 -m unittest discover -s infra/tests -t infra"""

from __future__ import annotations

import copy
import unittest

from bfx_infra.policy import (
    CAPS_MAX,
    ImagePolicy,
    PolicyError,
    check_host_command,
    sanitize_create,
    sanitize_exec,
    validate_topology,
)

FRR = "quay.io/frrouting/frr:10.7.1"
HOST = "breakfix-host:0.1.0"
IMAGES = ImagePolicy(
    refs={"router": FRR, "host": HOST},
    ids={"router": "sha256:" + "a" * 64, "host": "sha256:" + "b" * 64},
)
LABS = "/var/lib/breakfix-clab/labs"
LAB_DIR = f"{LABS}/bfx-t-demo"


def good_topology() -> dict:
    return {
        "name": "bfx-t-demo",
        "topology": {
            "nodes": {
                "r1": {
                    "kind": "linux",
                    "image": FRR,
                    "binds": ["r1/frr.conf:/etc/frr/frr.conf", "r1/daemons:/etc/frr/daemons"],
                    "cap-add": ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"],
                },
                "h1": {
                    "kind": "linux",
                    "image": HOST,
                    "exec": [
                        "ip link set eth1 up",
                        "ip addr add 10.0.1.10/24 dev eth1",
                        "ip route add default via 10.0.1.1",
                    ],
                },
            },
            "links": [{"endpoints": ["r1:eth1", "h1:eth1"]}],
        },
    }


class ValidateTopologyTest(unittest.TestCase):
    def test_good_topology_is_hardened(self) -> None:
        plan = validate_topology(good_topology(), IMAGES, LAB_DIR)
        self.assertEqual(plan.name, "bfx-t-demo")
        self.assertEqual(plan.files, ["r1/frr.conf", "r1/daemons"])
        self.assertEqual(plan.roles, {"r1": "router", "h1": "host"})
        r1 = plan.topology["topology"]["nodes"]["r1"]
        self.assertEqual(r1["network-mode"], "none")
        self.assertIs(r1["privileged"], False)
        self.assertEqual(r1["restart-policy"], "no")
        self.assertEqual(r1["binds"][0], f"{LAB_DIR}/files/r1/frr.conf:/etc/frr/frr.conf")
        self.assertEqual(r1["sysctls"]["net.ipv4.ip_forward"], "1")
        self.assertEqual(plan.topology["mgmt"], {"skip-when-unused": True})
        self.assertNotIn("sysctls", plan.topology["topology"]["nodes"]["h1"])

    def assert_refused(self, doc: object, fragment: str) -> None:
        with self.assertRaises(PolicyError) as ctx:
            validate_topology(doc, IMAGES, LAB_DIR)
        self.assertIn(fragment, str(ctx.exception))

    def mutate(self, fn) -> dict:  # type: ignore[no-untyped-def]
        doc = good_topology()
        fn(doc)
        return doc

    def test_refuses_bad_lab_names(self) -> None:
        for name in ("demo", "bfx-", "bfx-UPPER", "bfx-a/../b", "bfx-" + "a" * 40, None, 7):
            doc = self.mutate(lambda d, n=name: d.update(name=n))
            self.assert_refused(doc, "lab name")

    def test_refuses_privileged_and_unknown_node_keys(self) -> None:
        for key, value in (
            ("privileged", True),
            ("network-mode", "host"),
            ("cmd", "sh"),
            ("entrypoint", "sh"),
            ("ports", ["80:80"]),
            ("devices", ["/dev/kvm"]),
            ("env", {"A": "b"}),
            ("user", "root"),
            ("sysctls", {"kernel.x": "1"}),
        ):
            doc = self.mutate(lambda d, k=key, v=value: d["topology"]["nodes"]["r1"].update({k: v}))
            self.assert_refused(doc, "not allowed")

    def test_refuses_top_level_extras(self) -> None:
        self.assert_refused(self.mutate(lambda d: d.update(mgmt={"network": "x"})), "not allowed")
        self.assert_refused(self.mutate(lambda d: d.update(prefix="")), "not allowed")
        self.assert_refused(
            self.mutate(lambda d: d["topology"].update(kinds={"linux": {"privileged": True}})),
            "not allowed",
        )

    def test_refuses_foreign_images(self) -> None:
        for image in ("alpine:latest", "quay.io/frrouting/frr:latest", FRR + "x", None):
            doc = self.mutate(lambda d, i=image: d["topology"]["nodes"]["r1"].update(image=i))
            self.assert_refused(doc, "not an allowed lab image")

    def test_refuses_dangerous_binds(self) -> None:
        for bind in (
            "/:/host",
            "/etc/shadow:/etc/frr/frr.conf",
            "../x:/etc/frr/frr.conf",
            "r1/../../x:/etc/frr/frr.conf",
            "r1/frr.conf:/etc/passwd",
            "r1/frr.conf:/etc/frr/frr.conf:shared",
            "/var/run/docker.sock:/var/run/docker.sock",
        ):
            doc = self.mutate(lambda d, b=bind: d["topology"]["nodes"]["r1"].update(binds=[b]))
            with self.assertRaises(PolicyError, msg=bind):
                validate_topology(doc, IMAGES, LAB_DIR)

    def test_refuses_binds_on_hosts_and_exec_on_routers(self) -> None:
        doc = self.mutate(
            lambda d: d["topology"]["nodes"]["h1"].update(binds=["h1/x:/etc/frr/frr.conf"])
        )
        self.assert_refused(doc, "only routers")
        doc = self.mutate(lambda d: d["topology"]["nodes"]["r1"].update(exec=["ip link set eth1 up"]))
        self.assert_refused(doc, "only hosts")

    def test_refuses_host_exec_outside_allowlist(self) -> None:
        for cmd in (
            "sh -c 'curl x'",
            "ip link set eth1 up; rm -rf /",
            "ip addr add 10.0.0.1/24 dev eth1 && id",
            "ip addr add 300.0.0.1/24 dev eth1",
            "ip route add default via 10.0.0.1 dev lo",
            "ip netns exec x sh",
        ):
            doc = self.mutate(lambda d, c=cmd: d["topology"]["nodes"]["h1"].update(exec=[c]))
            with self.assertRaises(PolicyError, msg=cmd):
                validate_topology(doc, IMAGES, LAB_DIR)

    def test_refuses_caps_outside_role_maximum(self) -> None:
        for cap in ("SYS_MODULE", "SYS_PTRACE", "ALL", "DAC_READ_SEARCH", "BPF"):
            doc = self.mutate(lambda d, c=cap: d["topology"]["nodes"]["r1"].update({"cap-add": [c]}))
            self.assert_refused(doc, "capability not allowed")
        doc = self.mutate(lambda d: d["topology"]["nodes"]["h1"].update({"cap-add": ["SYS_ADMIN"]}))
        self.assert_refused(doc, "capability not allowed")

    def test_refuses_bad_links(self) -> None:
        for eps in (["r1:eth1"], ["r1:eth1", "zz:eth1"], ["r1:eth0", "h1:eth1"], ["r1:lo", "h1:eth1"]):
            doc = self.mutate(lambda d, e=eps: d["topology"].update(links=[{"endpoints": e}]))
            with self.assertRaises(PolicyError, msg=str(eps)):
                validate_topology(doc, IMAGES, LAB_DIR)
        doc = self.mutate(
            lambda d: d["topology"]["links"].append({"endpoints": ["r1:eth1", "h1:eth2"]})
        )
        self.assert_refused(doc, "used twice")


def create_body(**hc_overrides) -> dict:  # type: ignore[no-untyped-def]
    hc = {
        "Binds": [f"{LAB_DIR}/files/r1/frr.conf:/etc/frr/frr.conf"],
        "NetworkMode": "none",
        "CapAdd": ["NET_ADMIN", "SYS_ADMIN"],
        "Privileged": False,
        "Sysctls": {"net.ipv4.ip_forward": "1"},
        "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0},
        "Memory": 268435456,
        "CpuQuota": 50000,
        "CpuPeriod": 100000,
        "Ulimits": [{"Name": "nofile", "Hard": 1048576, "Soft": 1048576}],
        "LogConfig": {"Type": "", "Config": None},
        "PidMode": "",
        "Mounts": None,
        "ConsoleSize": [0, 0],
    }
    hc.update(hc_overrides)
    return {
        "Hostname": "r1",
        "Image": FRR,
        "Env": ["CLAB_LABEL=x"],
        "Cmd": None,
        "Entrypoint": None,
        "Labels": {"containerlab": "bfx-t-demo", "clab-node-name": "r1"},
        "HostConfig": hc,
        "NetworkingConfig": {"EndpointsConfig": None},
    }


class SanitizeCreateTest(unittest.TestCase):
    def test_hardens_a_containerlab_create(self) -> None:
        body, role = sanitize_create("clab-bfx-t-demo-r1", create_body(), IMAGES, LABS)
        hc = body["HostConfig"]
        self.assertEqual(role, "router")
        self.assertEqual(hc["CapDrop"], ["ALL"])
        self.assertEqual(hc["CapAdd"], ["NET_ADMIN", "SYS_ADMIN"])
        self.assertEqual(hc["SecurityOpt"], ["no-new-privileges"])
        self.assertEqual(hc["PidsLimit"], 256)
        self.assertEqual(hc["MemorySwap"], hc["Memory"])
        self.assertEqual(hc["NanoCpus"], 0)
        self.assertEqual(body["Labels"]["breakfix.role"], "router")

    def refused(self, body: dict, name: str = "clab-bfx-t-demo-r1") -> str:
        with self.assertRaises(PolicyError) as ctx:
            sanitize_create(name, body, IMAGES, LABS)
        return str(ctx.exception)

    def test_refuses_escapes(self) -> None:
        cases = {
            "privileged": create_body(Privileged=True),
            "host network": create_body(NetworkMode="host"),
            "bridge network": create_body(NetworkMode="bridge"),
            "host pid": create_body(PidMode="host"),
            "userns host": create_body(UsernsMode="host"),
            "devices": create_body(Devices=[{"PathOnHost": "/dev/sda"}]),
            "mounts": create_body(Mounts=[{"Source": "/", "Target": "/host"}]),
            "bind root": create_body(Binds=["/:/host"]),
            "bind outside lab": create_body(Binds=[f"{LABS}/bfx-t-other/files/x:/etc/frr/frr.conf"]),
            "bind traversal": create_body(Binds=[f"{LAB_DIR}/files/../../x:/etc/frr/frr.conf"]),
            "bind target": create_body(Binds=[f"{LAB_DIR}/files/r1/frr.conf:/root/x"]),
            "caps": create_body(CapAdd=["SYS_MODULE"]),
            "kernel sysctl": create_body(Sysctls={"kernel.core_pattern": "|/x"}),
            "cgroup parent": create_body(CgroupParent="/"),
            "port": create_body(PortBindings={"80/tcp": [{"HostPort": "80"}]}),
            "runtime": create_body(Runtime="sysbox-runc"),
            "unmask": create_body(MaskedPaths=["/proc/kcore"]),
            "gpu": create_body(DeviceRequests=[{"Count": -1}]),
            "ulimit": create_body(Ulimits=[{"Name": "memlock", "Hard": -1, "Soft": -1}]),
        }
        for label, body in cases.items():
            with self.subTest(label):
                self.refused(body)

    def test_security_opts_are_replaced_not_trusted(self) -> None:
        body, _ = sanitize_create(
            "clab-bfx-t-demo-r1",
            create_body(SecurityOpt=["seccomp=unconfined", "apparmor=unconfined"]),
            IMAGES,
            LABS,
        )
        self.assertEqual(body["HostConfig"]["SecurityOpt"], ["no-new-privileges"])

    def test_refuses_foreign_image_user_and_names(self) -> None:
        body = create_body()
        body["Image"] = "alpine:3"
        self.assertIn("not an allowed lab image", self.refused(body))
        body = create_body()
        body["User"] = "1000"
        self.assertIn("user", self.refused(body))
        body = create_body()
        body["Entrypoint"] = ["/bin/sh"]
        self.assertIn("Entrypoint", self.refused(body))
        self.assertIn("container name", self.refused(create_body(), name="evil"))
        body = create_body()
        body["Labels"]["containerlab"] = "prod"
        self.assertIn("lab name", self.refused(body, name="clab-prod-r1"))
        body = create_body()
        body["NetworkingConfig"] = {"EndpointsConfig": {"bridge": {}}}
        self.assertIn("network", self.refused(body))

    def test_host_role_gets_host_limits_and_no_binds(self) -> None:
        body = create_body(Binds=None, CapAdd=["NET_RAW"], Sysctls=None)
        body["Image"] = HOST
        body["Labels"]["clab-node-name"] = "h1"
        out, role = sanitize_create("clab-bfx-t-demo-h1", body, IMAGES, LABS)
        self.assertEqual(role, "host")
        self.assertEqual(out["HostConfig"]["PidsLimit"], 64)
        body["HostConfig"]["Binds"] = [f"{LAB_DIR}/files/r1/frr.conf:/etc/frr/frr.conf"]
        with self.assertRaises(PolicyError):
            sanitize_create("clab-bfx-t-demo-h1", body, IMAGES, LABS)

    def test_input_is_not_mutated(self) -> None:
        body = create_body()
        before = copy.deepcopy(body)
        sanitize_create("clab-bfx-t-demo-r1", body, IMAGES, LABS)
        self.assertEqual(body, before)


class SanitizeExecTest(unittest.TestCase):
    def test_router_interactive_vtysh_forces_pager_off(self) -> None:
        out = sanitize_exec(
            "router",
            {"Cmd": ["vtysh"], "Tty": True, "AttachStdin": True, "Env": ["VTYSH_PAGER=less"]},
        )
        self.assertEqual(out["Env"], ["VTYSH_PAGER=cat"])
        self.assertTrue(out["AttachStdin"])
        self.assertIs(out["Privileged"], False)

    def test_router_show_commands(self) -> None:
        sanitize_exec("router", {"Cmd": ["vtysh", "-c", "show ip route json"]})
        sanitize_exec("router", {"Cmd": ["vtysh", "-c", "show running-config"]})
        sanitize_exec("router", {"Cmd": ["vtysh", "-c", "show bgp neighbors 10.0.0.2 json"]})

    def test_router_refusals(self) -> None:
        for cmd in (
            ["sh"],
            ["/bin/sh", "-c", "id"],
            ["bash"],
            ["vtysh", "-c", "start-shell"],
            ["vtysh", "-c", "configure terminal"],
            ["vtysh", "-c", "show run | include x"],
            ["vtysh", "-c", "show run; start-shell"],
            ["vtysh", "-c", "show run\nstart-shell"],
            ["vtysh", "-c", "show run", "-c", "start-shell"],
            ["vtysh", "-b"],
            ["vtysh", "--vty_socket", "/tmp"],
            ["ip", "addr"],
        ):
            with self.subTest(cmd=cmd), self.assertRaises(PolicyError):
                sanitize_exec("router", {"Cmd": cmd})

    def test_exec_body_refusals(self) -> None:
        for body in (
            {"Cmd": ["vtysh"], "Privileged": True},
            {"Cmd": ["vtysh"], "User": "frr"},
            {"Cmd": ["vtysh"], "WorkingDir": "/"},
            {"Cmd": ["vtysh"], "Tty": True, "Extra": 1},
            {"Cmd": "vtysh"},
            {"Cmd": []},
            {"Cmd": ["vtysh\x00"]},
        ):
            with self.subTest(body=body), self.assertRaises(PolicyError):
                sanitize_exec("router", body)

    def test_host_commands(self) -> None:
        for cmd in (
            ["ping", "-c", "3", "10.0.3.10"],
            ["ping", "-c", "1", "-W", "2", "10.0.3.10"],
            ["traceroute", "-n", "10.0.3.10"],
            ["traceroute", "-n", "-w", "1", "-q", "1", "10.0.3.10"],
            ["ip", "addr"],
            ["ip", "-j", "addr", "show"],
            ["ip", "route"],
            ["ip", "-4", "route", "show", "dev", "eth1"],
            ["ip", "route", "get", "10.0.3.10"],
            ["ip", "-j", "link"],
        ):
            with self.subTest(cmd=cmd):
                out = sanitize_exec("host", {"Cmd": cmd})
                self.assertEqual(out["Env"], [])
                self.assertFalse(out["AttachStdin"])

    def test_host_refusals(self) -> None:
        for cmd in (
            ["sh"],
            ["ping", "10.0.3.10"],
            ["ping", "-c", "100000", "10.0.3.10"],
            ["ping", "-f", "-c", "5", "10.0.3.10"],
            ["ping", "-c", "3", "10.0.3.10;id"],
            ["ping", "-c", "3", "$(id)"],
            ["ping", "-c", "3", "example.com"],
            ["traceroute", "10.0.3.10", "10.0.3.11"],
            ["ip", "addr", "add", "1.2.3.4/24", "dev", "eth1"],
            ["ip", "route", "add", "default", "via", "1.1.1.1"],
            ["ip", "link", "set", "eth1", "down"],
            ["ip", "netns", "exec", "x", "sh"],
            ["ip", "-b", "/tmp/x"],
            ["ip", "route", "flush", "all"],
            ["cat", "/etc/shadow"],
            ["busybox", "sh"],
        ):
            with self.subTest(cmd=cmd), self.assertRaises(PolicyError):
                check_host_command(cmd)
        with self.assertRaises(PolicyError):
            sanitize_exec("host", {"Cmd": ["ping", "-c", "1", "10.0.0.1"], "Tty": True})

    def test_caps_max_never_contains_the_worst_caps(self) -> None:
        worst = {"SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO", "SYS_BOOT", "DAC_READ_SEARCH", "BPF", "PERFMON"}
        for role, caps in CAPS_MAX.items():
            self.assertFalse(caps & worst, role)


if __name__ == "__main__":
    unittest.main()
