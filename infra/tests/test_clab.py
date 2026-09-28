"""breakfix-clab pieces that can be tested without root or Docker."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest

from bfx_infra import clab
from bfx_infra.policy import PolicyError


class ReadRegularFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_reads_small_regular_files(self) -> None:
        path = os.path.join(self.dir, "frr.conf")
        with open(path, "wb") as fh:
            fh.write(b"hostname r1\n")
        self.assertEqual(clab.read_regular_file(path, 100), b"hostname r1\n")

    def test_refuses_symlinks_even_to_readable_files(self) -> None:
        target = os.path.join(self.dir, "real")
        with open(target, "wb") as fh:
            fh.write(b"x")
        link = os.path.join(self.dir, "frr.conf")
        os.symlink("/etc/passwd", link)
        with self.assertRaises(PolicyError):
            clab.read_regular_file(link, 100)

    def test_refuses_directories_fifos_and_large_files(self) -> None:
        with self.assertRaises(PolicyError):
            clab.read_regular_file(self.dir, 100)
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        with self.assertRaises(PolicyError):
            clab.read_regular_file(fifo, 100)
        big = os.path.join(self.dir, "big")
        with open(big, "wb") as fh:
            fh.write(b"x" * 101)
        with self.assertRaises(PolicyError):
            clab.read_regular_file(big, 100)


class ReadConfigDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.realpath(self.tmp.name)
        os.mkdir(os.path.join(self.src, "r1"))
        for name in ("frr.conf", "daemons"):
            with open(os.path.join(self.src, "r1", name), "w", encoding="utf-8") as fh:
                fh.write(name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_reads_the_allowed_files_only(self) -> None:
        with open(os.path.join(self.src, "r1", "extra.sh"), "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh")
        files = clab.read_config_dir(self.src, "r1")
        self.assertEqual(sorted(files), ["daemons", "frr.conf"])

    def test_requires_frr_conf_and_daemons(self) -> None:
        os.unlink(os.path.join(self.src, "r1", "daemons"))
        with self.assertRaises(PolicyError):
            clab.read_config_dir(self.src, "r1")

    def test_refuses_symlinked_dirs_and_files(self) -> None:
        os.symlink("/etc", os.path.join(self.src, "r2"))
        with self.assertRaises(PolicyError):
            clab.read_config_dir(self.src, "r2")
        os.unlink(os.path.join(self.src, "r1", "frr.conf"))
        os.symlink("/etc/passwd", os.path.join(self.src, "r1", "frr.conf"))
        with self.assertRaises(PolicyError):
            clab.read_config_dir(self.src, "r1")

    def test_refuses_a_path_through_a_symlinked_parent(self) -> None:
        os.mkdir(os.path.join(self.src, "real"))
        os.mkdir(os.path.join(self.src, "real", "r9"))
        os.symlink(os.path.join(self.src, "real"), os.path.join(self.src, "cfg"))
        with self.assertRaises(PolicyError):
            clab.read_config_dir(self.src, "cfg/r9")


class LabDirTest(unittest.TestCase):
    def test_lab_dir_stays_under_the_labs_root(self) -> None:
        self.assertEqual(clab.lab_dir_for("bfx-t-a1"), f"{clab.LABS_ROOT}/bfx-t-a1")
        for bad in ("../etc", "bfx-t/../../etc", "/etc", "bfx-t-a1/x"):
            with self.assertRaises(PolicyError):
                clab.lab_dir_for(bad)


class MainTest(unittest.TestCase):
    @unittest.skipIf(os.geteuid() == 0, "runs as root")
    def test_refuses_to_run_without_root(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = clab.main(["list"])
        self.assertEqual(code, 1)
        self.assertIn("root", json.loads(out.getvalue())["error"])


if __name__ == "__main__":
    unittest.main()
