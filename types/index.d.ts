// Next Up's state contract: the task model, and the values its drawings read.

export type Kind = 'suggested' | 'added' | 'plan'

export type Source = { kind: 'chip' | 'tool' | 'manual'; session: string; at: string }

export type Task = {
  id: string
  title: string
  // The card's summary, about three lines.
  detail: string
  // The full prompt Now and New send.
  prompt: string
  repo: { root: string; name: string } | null
  kind: Kind
  plan?: { id: string; title: string; step: number; of: number }
  // done: its prompt was sent.
  status: 'open' | 'done' | 'dropped'
  favourite: boolean
  seen: number
  sources: Source[]
  createdAt: string
  updatedAt: string
}

export type Project = Task['repo']

export type Tab = 'favourites' | 'project' | 'all'

// A step of the work in this session, kept by Claude through
// update_session_tasks. In memory only: it ends with the session.
export type SessionTask = {
  // Short, for Claude to refer to: s1, s2, ...
  id: string
  title: string
  detail: string
  // removed: dropped by Claude or the user. Kept, hidden, so its id is never
  // given to another task.
  status: 'todo' | 'done' | 'removed'
  createdAt: string
  doneAt?: string
}

export type TasksTab = 'todo' | 'done'

declare module 'claude-code' {
  interface PluginState {
    'next-up': {
      // Every task, folded from all sessions' logs.
      tasks: Task[]
      // The session's project (its git root), or null outside one.
      project: Project
      tab: Tab
      // The session-start list: shown in a new session until the first prompt.
      band: boolean
      // This session's own task list, in the order Claude planned it.
      session: SessionTask[]
      tasksTab: TasksTab
    }
  }
}
