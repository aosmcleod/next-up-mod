// What the footer, pane and session-start list show, as plain functions.

import type { Project, Tab, Task } from '../types'

// Between the count and the name: a space and a no-break space, since the
// desktop draws labels as web text and folds two plain spaces into one.
export const GAP = ' \u00a0'

export const AMBER = '#d48a1a'
export const BLUE = '#6ea8e0'
export const PURPLE = '#b392f0'

// Open tasks for a project, or every open task outside one.
export function openFor(tasks: Task[], project: Project): Task[] {
  return tasks.filter(t => t.status === 'open' && (project === null || t.repo?.root === project.root))
}

// Favourites first, then newest first.
export function ordered(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => Number(b.favourite) - Number(a.favourite) || b.createdAt.localeCompare(a.createdAt))
}

// The footer button: "<open here>  Next Up ↗", or just the name with none.
export function footerLabel(tasks: Task[], project: Project): string {
  const count = openFor(tasks, project).length

  return count > 0 ? `${count}${GAP}Next Up ↗` : 'Next Up ↗'
}

export type PaneView = {
  tabs: Array<{ id: Tab; label: string }>
  current: Tab
  // Cards in order; a header starts each project group in ★ and All.
  // A header's key is the project's root (two clones can share a name).
  items: Array<{ kind: 'header'; key: string; name: string } | { kind: 'card'; task: Task }>
}

const NO_PROJECT = 'No project'

// Projects are told apart by their root; tasks outside any share one group.
function groupOf(task: Task): { key: string; name: string } {
  return task.repo ? { key: task.repo.root, name: task.repo.name } : { key: '', name: NO_PROJECT }
}

// The pane's tabs and list. The project tab exists only inside a project;
// ★ and All group by project, this project first, then by name.
export function paneView(tasks: Task[], project: Project, tab: Tab): PaneView {
  const open = tasks.filter(t => t.status === 'open')
  const here = project ? open.filter(t => t.repo?.root === project.root) : []
  const favourites = open.filter(t => t.favourite)
  const tabs: PaneView['tabs'] = [
    { id: 'favourites', label: `★ ${favourites.length}` },
    ...(project ? [{ id: 'project' as const, label: `${project.name} ${here.length}` }] : []),
    { id: 'all', label: `All ${open.length}` },
  ]
  const current: Tab = tab === 'project' && !project ? 'all' : tab
  if (current === 'project') return { tabs, current, items: ordered(here).map(task => ({ kind: 'card', task })) }

  const shown = current === 'favourites' ? favourites : open
  const groups = [...new Map(shown.map(t => [groupOf(t).key, groupOf(t)])).values()].sort((a, b) =>
    a.key === project?.root ? -1 : b.key === project?.root ? 1 : a.key === '' ? 1 : b.key === '' ? -1 : a.name.localeCompare(b.name),
  )
  const items: PaneView['items'] = groups.flatMap(group => [
    { kind: 'header' as const, ...group },
    ...ordered(shown.filter(t => groupOf(t).key === group.key)).map(task => ({ kind: 'card' as const, task })),
  ])

  return { tabs, current, items }
}

// The session-start list: up to three open tasks for the project (every
// project outside one), favourites first.
export function bandTasks(tasks: Task[], project: Project): Task[] {
  return ordered(openFor(tasks, project)).slice(0, 3)
}

// The label's colour, text only: plans amber, added blue, suggestions purple.
export function labelColour(task: Task): string {
  if (task.kind === 'plan') return AMBER

  return task.kind === 'added' ? BLUE : PURPLE
}

// About three lines of description: the site's width in cells times three,
// plus a third for the desktop's proportional font fitting more per cell.
export function detailCap(columns: number): number {
  return Math.max(60, Math.floor((columns - 6) * 3 * 1.3))
}

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}
