import type { EngineInterface } from 'claude-code'

import type { TaskEvent } from './store'

// The store's files. Each session writes only its own log, so two sessions
// never write the same file; every session reads all of them.
//
//   ~/.claude/next-up/log/<session>.jsonl   one event per line
//
// The functions take only the file operations they use (the hooks module
// wraps $.fs), so tests can hand them an in-memory stand-in.

export type Files = Pick<EngineInterface['fs'], 'exists' | 'list' | 'read' | 'write'>

// The logs' names, sizes and times, joined: a change in any log changes it, so
// a session can poll this cheaply and fold again only when it moves.
export async function logsSignature(fs: Files, dir: string): Promise<string> {
  const logDir = `${dir}/log`
  if (!(await fs.exists(logDir))) return ''
  const entries = await fs.list(logDir)

  return entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .map(entry => `${entry.name}:${entry.size}:${entry.mtimeMs}`)
    .sort()
    .join('|')
}

// Each log's parsed events, by file name, with the size and time they were read
// at. Logs only grow, and only one session writes each, so most stay unchanged
// between reads.
export type LogCache = Map<string, { stamp: string; events: TaskEvent[] }>

function parse(text: string): TaskEvent[] {
  const events: TaskEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as TaskEvent)
    } catch {
      // A torn or hand-edited line: skip it.
    }
  }

  return events
}

// Every event in every log. A line that does not parse is skipped, so one bad
// write never hides the rest. Given a cache, only logs whose size or time
// moved since the last read are read again.
export async function readEvents(fs: Files, dir: string, cache: LogCache = new Map()): Promise<TaskEvent[]> {
  const logDir = `${dir}/log`
  if (!(await fs.exists(logDir))) {
    cache.clear()
    return []
  }
  const seen = new Set<string>()
  const events: TaskEvent[] = []
  for (const entry of await fs.list(logDir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    seen.add(entry.name)
    const stamp = `${entry.size}:${entry.mtimeMs}`
    let cached = cache.get(entry.name)
    if (cached?.stamp !== stamp) {
      // A log that cannot be read (removed since the listing, too large, no
      // permission) keeps what was last read of it, or is skipped, so it never
      // hides the others.
      const text = await fs.read(`${logDir}/${entry.name}`).catch(() => null)
      if (text === null) {
        if (cached) events.push(...cached.events)
        continue
      }
      cached = { stamp, events: parse(text) }
      cache.set(entry.name, cached)
    }
    events.push(...cached.events)
  }
  for (const name of cache.keys()) if (!seen.has(name)) cache.delete(name)

  return events
}

// Appends to this session's own log. $.fs has no append, so this rewrites the
// file; safe because no other session writes it.
export async function appendEvents(fs: Files, dir: string, session: string, events: TaskEvent[]): Promise<void> {
  if (events.length === 0) return
  const file = `${dir}/log/${session}.jsonl`
  const before = (await fs.exists(file)) ? await fs.read(file) : ''
  await fs.write(file, before + events.map(event => `${JSON.stringify(event)}\n`).join(''))
}
