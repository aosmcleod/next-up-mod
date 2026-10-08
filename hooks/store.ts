// Next Up's store: plain functions, no `$`. Every session appends events to its
// own log (~/.claude/next-up/log/<session>.jsonl); every session folds all logs
// into one task list. Last write wins per field.

// The task model lives in the state contract (types/), which the drawings read.
import type { Source, Task } from '../types'

export type { Kind, Project, Source, Task } from '../types'

type Stamp = { v: 1; at: string; by: string }

export type TaskEvent =
  | (Stamp & { op: 'add'; task: Task })
  | (Stamp & { op: 'merge'; id: string; source: Source })
  | (Stamp & { op: 'set'; id: string; fields: Partial<Pick<Task, 'title' | 'detail' | 'prompt' | 'status' | 'favourite'>> })

// Folds events from every log into the current list, oldest event first.
export function fold(events: TaskEvent[]): Task[] {
  const byId = new Map<string, Task>()
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.by.localeCompare(b.by))
  for (const e of sorted) {
    if (e.op === 'add') {
      if (!byId.has(e.task.id)) byId.set(e.task.id, { ...e.task })
      continue
    }
    const task = byId.get(e.id)
    if (!task) continue
    if (e.op === 'merge') {
      byId.set(e.id, { ...task, seen: task.seen + 1, sources: [...task.sources, e.source], updatedAt: e.at })
    } else {
      byId.set(e.id, { ...task, ...e.fields, updatedAt: e.at })
    }
  }

  return [...byId.values()]
}

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'is', 'be', 'this', 'that', 'it', 'at', 'by'])

// Title words for comparison: lowercase, punctuation dropped, stopwords out,
// a trailing plural "s" trimmed. Letters and digits of any script count.
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(w => w && !STOPWORDS.has(w))
    .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
}

// Word overlap of two titles, 0 to 1 (Jaccard).
export function similarity(a: string, b: string): number {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared += 1

  return shared / (x.size + y.size - shared)
}

// Word overlap at or above this is a near duplicate. At 0.6, short titles that
// differ by one meaningful word ("Add tests for X" / "Add docs for X") merged.
const NEAR = 0.75

// An open task in the same project that the candidate repeats: the same words
// (exact) or most of them (near). A plan's steps are asked for deliberately,
// so they are never merged away. A title with no words matches nothing.
export function findDuplicate(candidate: Pick<Task, 'title' | 'repo' | 'plan'>, tasks: Task[]): { task: Task; match: 'exact' | 'near' } | null {
  if (candidate.plan) return null
  const key = words(candidate.title).join(' ')
  if (!key) return null
  let best: { task: Task; score: number } | null = null
  for (const task of tasks) {
    if (task.status !== 'open' || (task.repo?.root ?? null) !== (candidate.repo?.root ?? null)) continue
    if (words(task.title).join(' ') === key) return { task, match: 'exact' }
    const score = similarity(task.title, candidate.title)
    if (score >= NEAR && (!best || score > best.score)) best = { task, score }
  }

  return best ? { task: best.task, match: 'near' } : null
}

// The event to append for an incoming task: a merge into a duplicate, or an add.
export function eventForIncoming(task: Task, tasks: Task[], by: string): TaskEvent {
  const duplicate = findDuplicate(task, tasks)
  const source = task.sources[0] ?? { kind: 'tool', session: by, at: task.createdAt }
  if (duplicate) return { v: 1, at: task.createdAt, by, op: 'merge', id: duplicate.task.id, source }

  return { v: 1, at: task.createdAt, by, op: 'add', task }
}

// The card's label: Suggested (a Claude chip), Added (you, or Claude when
// asked), Plan n/m.
export function labelOf(task: Task): string {
  if (task.kind === 'plan' && task.plan) return `Plan ${task.plan.step}/${task.plan.of}`

  return task.kind === 'added' ? 'Added' : 'Suggested'
}

const OPENING = 80
// Below this an opening is too generic to find inside a longer prompt
// ("Fix lint"), so a short prompt has to be sent exactly.
const MIN_OPENING = 30

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

// A sent prompt "is" a task when it still carries the task's opening: the
// first 80 characters, whitespace folded. Edits after that still count.
export function isSubmissionOf(submitted: string, task: Task): boolean {
  const prompt = squash(task.prompt)
  const opening = prompt.slice(0, OPENING)
  if (opening.length < MIN_OPENING) return opening.length > 0 && squash(submitted) === prompt

  return squash(submitted).includes(opening)
}

// The open task in this project (or outside any, outside one) that a sent
// prompt starts; the longest opening wins when several fit.
export function submittedTask(submitted: string, tasks: Task[], project: Task['repo']): Task | null {
  const here = tasks.filter(t => t.status === 'open' && (t.repo?.root ?? null) === (project?.root ?? null))
  const matches = here.filter(t => isSubmissionOf(submitted, t))

  return matches.sort((a, b) => squash(b.prompt).slice(0, OPENING).length - squash(a.prompt).slice(0, OPENING).length)[0] ?? null
}

// "now", "5m", "2h", "3d", "2w".
export function ageOf(iso: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`

  return `${Math.floor(seconds / 604800)}w`
}
