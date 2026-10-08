import { expect, test } from 'claude-code/testing'

import { fold } from '../hooks/store'
import type { Task, TaskEvent } from '../hooks/store'
import { appendEvents, logsSignature, readEvents } from '../hooks/store-io'
import type { Files } from '../hooks/store-io'

// An in-memory stand-in for $.fs: files by path, directories implied by them.
function memoryFiles(): Files & { files: Map<string, string> } {
  const files = new Map<string, string>()
  let clock = 0
  const times = new Map<string, number>()

  return {
    files,
    exists: async path => files.has(path) || [...files.keys()].some(f => f.startsWith(`${path}/`)),
    read: (async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`missing ${path}`)
      return text
    }) as Files['read'],
    write: async (path, text) => {
      files.set(path, text)
      times.set(path, ++clock)
    },
    list: async (dir = '.') => {
      const names = [...files.keys()].filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
      return names.map(f => ({
        name: f.slice(dir.length + 1),
        kind: 'file' as const,
        size: files.get(f)?.length ?? 0,
        mtimeMs: times.get(f) ?? 0,
        isLink: false,
      })) as Awaited<ReturnType<Files['list']>>
    },
  }
}

const DIR = '/home/me/.claude/next-up'
const AT = '2026-10-07T10:00:00.000Z'
const BASE: Task = {
  id: 't1', title: 'First', detail: '', prompt: 'First task prompt', repo: null, kind: 'added',
  status: 'open', favourite: false, seen: 1, sources: [], createdAt: AT, updatedAt: AT,
}
const add = (t: Task, by: string): TaskEvent => ({ v: 1, at: t.createdAt, by, op: 'add', task: t })

test('two sessions append to their own logs and both read one list', async () => {
  const fs = memoryFiles()
  expect(await readEvents(fs, DIR)).toEqual([])
  expect(await logsSignature(fs, DIR)).toBe('')

  await appendEvents(fs, DIR, 'session-a', [add(BASE, 'session-a')])
  const before = await logsSignature(fs, DIR)
  await appendEvents(fs, DIR, 'session-b', [add({ ...BASE, id: 't2', title: 'Second', createdAt: '2026-10-07T10:01:00.000Z' }, 'session-b')])
  await appendEvents(fs, DIR, 'session-a', [{ v: 1, at: '2026-10-07T10:02:00.000Z', by: 'session-a', op: 'set', id: 't2', fields: { favourite: true } }])

  expect([...fs.files.keys()].sort()).toEqual([`${DIR}/log/session-a.jsonl`, `${DIR}/log/session-b.jsonl`])
  expect(await logsSignature(fs, DIR)).not.toBe(before)
  const list = fold(await readEvents(fs, DIR))
  expect(list.map(t => t.id).sort()).toEqual(['t1', 't2'])
  expect(list.find(t => t.id === 't2')?.favourite).toBe(true)
})

test('a torn line is skipped and the rest still reads', async () => {
  const fs = memoryFiles()
  await appendEvents(fs, DIR, 'session-a', [add(BASE, 'session-a')])
  const file = `${DIR}/log/session-a.jsonl`
  await fs.write(file, `${await fs.read(file)}{"v":1,"op":"add","task":{"id":"t9"\n`)
  expect(fold(await readEvents(fs, DIR)).map(t => t.id)).toEqual(['t1'])
})

test('with a cache, only logs that changed are read again', async () => {
  const fs = memoryFiles()
  const reads: string[] = []
  const counted: Files = { ...fs, read: (async (path: string) => (reads.push(path), fs.read(path))) as Files['read'] }
  const cache = new Map()
  await appendEvents(fs, DIR, 'session-a', [add(BASE, 'session-a')])
  await appendEvents(fs, DIR, 'session-b', [add({ ...BASE, id: 't2' }, 'session-b')])
  await readEvents(counted, DIR, cache)
  expect(reads.length).toBe(2)

  reads.length = 0
  await appendEvents(fs, DIR, 'session-b', [{ v: 1, at: '2026-10-07T10:05:00.000Z', by: 'session-b', op: 'set', id: 't2', fields: { favourite: true } }])
  const list = fold(await readEvents(counted, DIR, cache))
  expect(reads).toEqual([`${DIR}/log/session-b.jsonl`])
  expect(list.find(t => t.id === 't2')?.favourite).toBe(true)

  fs.files.delete(`${DIR}/log/session-a.jsonl`)
  expect(fold(await readEvents(counted, DIR, cache)).map(t => t.id)).toEqual(['t2'])
  expect([...cache.keys()]).toEqual(['session-b.jsonl'])
})

test('appending nothing writes nothing', async () => {
  const fs = memoryFiles()
  await appendEvents(fs, DIR, 'session-a', [])
  expect(fs.files.size).toBe(0)
})
