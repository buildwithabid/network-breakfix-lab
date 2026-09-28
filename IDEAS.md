# Ideas

Ideas that are not in PLAN.md go here, not into code.

- Run `breakfix-clab` as a root daemon behind a unix socket (like docker-guard) that accepts the
  rendered lab as data instead of a directory path. The server would then need no sudo at all, so its
  unit could set `NoNewPrivileges`, `ProtectSystem=strict` and an empty capability bounding set.
