// How tasks come in, as plain functions: from Claude's suggestion chips and
// from the add_tasks tool. No `$`; the hooks module does the reading and writing.

import { labelOf } from './store'
import type { Project, Task } from './store'

export type { Project } from './store'

export type Stamp = { session: string; now: string; newId: () => string }

const TITLE_MAX = 80

function clean(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

function base(stamp: Stamp, project: Project): Pick<Task, 'repo' | 'status' | 'favourite' | 'seen' | 'createdAt' | 'updatedAt'> {
  return { repo: project, status: 'open', favourite: false, seen: 1, createdAt: stamp.now, updatedAt: stamp.now }
}

// A suggestion chip (the desktop's spawn_task: title, tldr, prompt) as a task.
// Null when it has no title or prompt to keep.
export function taskFromChip(args: { title?: unknown; tldr?: unknown; prompt?: unknown }, project: Project, stamp: Stamp): Task | null {
  const title = clean(args.title)
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!title || !prompt) return null

  return {
    ...base(stamp, project),
    id: stamp.newId(),
    title: short(title, TITLE_MAX),
    detail: clean(args.tldr),
    prompt,
    kind: 'suggested',
    sources: [{ kind: 'chip', session: stamp.session, at: stamp.now }],
  }
}

export type AddInput = {
  tasks?: Array<{ title?: unknown; details?: unknown; prompt?: unknown }>
  plan?: { title?: unknown }
}

// add_tasks' input as tasks: "Added", or "Plan n/m" when a plan title is given
// (steps numbered in the order listed). A task without a prompt gets its title
// and details as one.
export function tasksFromAddInput(input: AddInput, project: Project, stamp: Stamp): Task[] {
  const items = (input.tasks ?? []).filter(t => clean(t.title))
  const planTitle = clean(input.plan?.title)
  const planId = planTitle ? stamp.newId() : ''

  return items.map((item, i) => {
    const title = short(clean(item.title), TITLE_MAX)
    const details = typeof item.details === 'string' ? item.details.trim() : ''
    const prompt = typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt.trim() : [title, details].filter(Boolean).join('\n\n')

    return {
      ...base(stamp, project),
      id: stamp.newId(),
      title,
      detail: clean(details) || (planTitle ? `${planTitle}, step ${i + 1} of ${items.length}` : ''),
      prompt,
      kind: planTitle ? ('plan' as const) : ('added' as const),
      ...(planTitle ? { plan: { id: planId, title: planTitle, step: i + 1, of: items.length } } : {}),
      sources: [{ kind: 'tool' as const, session: stamp.session, at: stamp.now }],
    }
  })
}

// Open tasks as text, for list_tasks and /next: favourites first, newest first.
// Outside a project (or for "all"), each line names its project.
export function listText(tasks: Task[], project: Project, scope: 'project' | 'all'): string {
  const open = tasks.filter(t => t.status === 'open' && (scope === 'all' || project === null || t.repo?.root === project.root))
  if (open.length === 0) return scope === 'all' || project === null ? 'Next Up is empty.' : `No open tasks for ${project.name}.`
  const sorted = [...open].sort((a, b) => Number(b.favourite) - Number(a.favourite) || b.createdAt.localeCompare(a.createdAt))
  const showProject = scope === 'all' || project === null

  return sorted
    .map(t => {
      const where = showProject ? ` [${t.repo?.name ?? 'no project'}]` : ''
      const star = t.favourite ? '★ ' : ''
      return `- ${star}${t.title} (${labelOf(t)}, id ${t.id})${where}${t.detail ? `: ${t.detail}` : ''}`
    })
    .join('\n')
}
