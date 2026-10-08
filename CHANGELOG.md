# Changelog

All notable changes to Next Up are recorded here. It follows
[semantic versioning](https://semver.org/).

## 1.0.0 — 2026-10-08

The first public release.

### Next Up, the backlog

- Collects the follow-ups Claude suggests (desktop suggestion chips, and its `add_tasks` tool)
  into one backlog shared by every session and project, with near-duplicates merged.
- A footer button with the open count for the session's project, and a pane with ★, project and
  All tabs.
- **Now** puts a task's prompt in the prompt box; **New** opens a new desktop session in the
  task's project with the prompt ready. Sending a task's prompt marks it done.
- `/next plan <goal>` has Claude break a goal into ordered steps in the backlog.
- Data in `~/.claude/next-up/log/`, one append-only log per session.

### Tasks, the session list

- Claude keeps a list for multi-step work in the session through `update_session_tasks`: it
  plans the steps first, marks each done as it goes, and rewords or removes steps as the work
  changes.
- A footer button with the count still to do, and a pane with To Do and Done tabs. Mark a step
  done or remove it from the pane, and Claude is told with your next message.

### Settings

- Next Up and Tasks can each be switched off in `/config`.
