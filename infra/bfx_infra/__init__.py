"""Root-side helpers for network-breakfix-lab.

These modules are installed root-owned into /usr/local/lib/breakfix by scripts/bootstrap.sh and
run by the system Python in isolated mode. They use only the standard library and Debian's
python3-yaml, so no package from npm or PyPI ever executes with Docker or root access.
"""
