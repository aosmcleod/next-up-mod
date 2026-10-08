// The session's own task list, as plain functions: the steps of the work in
// hand, kept by Claude through update_session_tasks and edited from the Tasks
// pane. No `$`; the hooks module keeps the list in state.

import type { SessionTask, TasksTab } from '../types'
import { GAP } from './view'

export type { SessionTask, TasksTab } from '../types'

export type SessionChanges = {
  add?: Array<{ title?: unknown; details?: unknown }>
  update?: Array<{ id?: unknown; title?: unknown; details?: unknown }>
  done?: unknown[]
  remove?: unknown[]
}

const TITLE_MAX = 80

function clean(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

function shorten(title: string): string {
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

// The next free short id: one past the highest s<n> ever given (removed tasks
// stay in the list, hidden, for this).
function nextNumber(tasks: SessionTask[]): number {
  return tasks.reduce((n, t) => Math.max(n, Number(t.id.slice(1)) || 0), 0) + 1
}

// Applies Claude's changes: rewordings, removals, completions, then additions
// (which go to the end, in the order given). Unknown ids are reported, not
// fatal.
export function applyChanges(tasks: SessionTask[], changes: SessionChanges, now: string): { tasks: SessionTask[]; unknown: string[] } {
  const ids = new Set(tasks.filter(t => t.status !== 'removed').map(t => t.id))
  const named = (list: unknown[] | undefined) => (list ?? []).map(id => String(id).trim()).filter(Boolean)
  const remove = new Set(named(changes.remove))
  const done = new Set(named(changes.done))
  const updates = new Map<string, { title: string; details: string | null }>()
  for (const u of changes.update ?? []) {
    const id = String(u.id ?? '').trim()
    if (id) updates.set(id, { title: clean(u.title), details: typeof u.details === 'string' ? clean(u.details) : null })
  }
  const unknown = [...remove, ...done, ...updates.keys()].filter(id => !ids.has(id))

  let next = tasks.map(t => {
    if (t.status === 'removed') return t
    const u = updates.get(t.id)
    if (u) t = { ...t, ...(u.title ? { title: shorten(u.title) } : {}), ...(u.details !== null ? { detail: u.details } : {}) }
    if (remove.has(t.id)) return { ...t, status: 'removed' as const }
    if (done.has(t.id) && t.status === 'todo') return { ...t, status: 'done' as const, doneAt: now }
    return t
  })
  let n = nextNumber(tasks)
  for (const item of changes.add ?? []) {
    const title = clean(item.title)
    if (!title) continue
    next = [...next, { id: `s${n}`, title: shorten(title), detail: clean(item.details), status: 'todo', createdAt: now }]
    n += 1
  }

  return { tasks: next, unknown: [...new Set(unknown)] }
}

// The list as Claude reads it, in a tool result or beside a prompt.
export function sessionText(tasks: SessionTask[]): string {
  if (tasks.length === 0) return 'The session task list is empty.'
  const line = (t: SessionTask) => `- [${t.id}] ${t.title}${t.detail ? `: ${t.detail}` : ''}`
  const todo = tasks.filter(t => t.status === 'todo')
  const done = tasks.filter(t => t.status === 'done')

  return [
    `To do (${todo.length}):`,
    ...(todo.length ? todo.map(line) : ['- nothing left']),
    `Done (${done.length}):`,
    ...(done.length ? done.map(line) : ['- nothing yet']),
  ].join('\n')
}

// What the user changed from the pane, for Claude to hear before its next turn.
export type UserEdits = { done: SessionTask[]; removed: SessionTask[] }

export function editsNote(tasks: SessionTask[], edits: UserEdits): string | null {
  if (edits.done.length === 0 && edits.removed.length === 0) return null
  const names = (list: SessionTask[]) => list.map(t => `[${t.id}] ${t.title}`).join('; ')
  const lines = ['The user edited the session task list (in the Tasks pane) since you last saw it. Treat their changes as decided: do not redo or re-add these.']
  if (edits.done.length) lines.push(`Marked done by the user: ${names(edits.done)}.`)
  if (edits.removed.length) lines.push(`Removed by the user: ${names(edits.removed)}.`)
  lines.push('', 'The list now:', sessionText(tasks))

  return lines.join('\n')
}

// Beside each prompt while steps remain, so Claude sees the list without
// asking for it.
export function openReminder(tasks: SessionTask[]): string | null {
  const todo = tasks.filter(t => t.status === 'todo')
  if (todo.length === 0) return null

  return [
    `Session tasks still to do (${todo.length}), in order. Keep them current with update_session_tasks: mark each done as it is finished, add or reword steps as the work changes.`,
    ...todo.map(t => `- [${t.id}] ${t.title}`),
  ].join('\n')
}

// The footer button: "<to do>  Tasks ↗", or just the name with none.
export function tasksLabel(tasks: SessionTask[]): string {
  const count = tasks.filter(t => t.status === 'todo').length

  return count > 0 ? `${count}${GAP}Tasks ↗` : 'Tasks ↗'
}

// The Tasks pane: To Do in planned order, Done newest first.
export function tasksView(tasks: SessionTask[], tab: TasksTab): { tabs: Array<{ id: TasksTab; label: string }>; items: SessionTask[] } {
  const todo = tasks.filter(t => t.status === 'todo')
  const done = tasks.filter(t => t.status === 'done').sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))

  return {
    tabs: [
      { id: 'todo', label: `To Do ${todo.length}` },
      { id: 'done', label: `Done ${done.length}` },
    ],
    items: tab === 'done' ? done : todo,
  }
}
