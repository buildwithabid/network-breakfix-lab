# Results and the assessment bundle

When a session ends (the candidate submits, or time runs out) the server:

1. captures `show running-config` on every router (it also did so when the lab started),
2. runs every objective's check against the live lab,
3. stores the results, then destroys the lab.

## Results page (`GET /api/session/results`)

Shown to the candidate after the test: pass/fail per objective with the reason, time taken, every
command per device in order with timestamps, and a unified diff of each router's config (start →
submit).

## Assessment bundle (`GET /api/session/bundle`)

One versioned JSON document per attempt, designed so a later assessment step (a reviewer, or an AI
model) gets everything in one place without touching the database or the lab:

```jsonc
{
  "schema": "breakfix.assessment/v1",
  "generatedAt": "2026-09-28T11:12:13.000Z",
  "scenario": {            // what the candidate was asked to do, and how it was checked
    "id": "01-wrong-ip-mask", "title": "…", "difficulty": "easy", "ticket": "…",
    "timeLimitMinutes": 20,
    "objectives": [{ "id": "…", "description": "…", "negate": false, "rule": { "type": "route-present", … } }],
    "hints": ["…"]
  },
  "attempt": { "sessionId": "…", "endReason": "submitted", "startedAt": "…", "finishedAt": "…", "durationSeconds": 412 },
  "outcome": {
    "passed": 4, "total": 4,
    "objectives": [{ "id": "…", "passed": true, "detail": "r2 → 10.0.12.0/30: connected", "probe": { "kind": "vtysh", … } }]
  },
  "timeline": [            // every command, in order, relative to the lab becoming ready
    { "at": "…", "offsetSeconds": 35, "node": "r2", "kind": "vtysh", "command": "show ip route", "outcome": "exec" },
    { "at": "…", "offsetSeconds": 80, "node": "h1", "kind": "host", "command": "ping -c 4 -W 1 10.0.3.10", "outcome": "exit 0" },
    { "at": "…", "offsetSeconds": 95, "node": "-", "kind": "hint", "command": "hint 1", "outcome": null }
  ],
  "configs": [{ "node": "r2", "start": "…", "end": "…", "diff": "--- r2 (at start)\n+++ r2 (at submit)\n…" }]
}
```

Field notes:

- `timeline[].outcome`: for `vtysh`, the CLI mode the command was entered in (`exec`, `config`,
  `config-if`, …); for `host`, `exit N` or `rejected: <reason>` (rejected attempts are kept, they
  say something about the candidate too); `hint N` entries record when a hint was opened.
- Commands are recorded as vtysh saw them (after tab completion and history recall), not as raw
  keystrokes. The server's own polling for the live diagram is never in the timeline.
- `schema` changes only with a breaking change; new fields may be added within v1.
