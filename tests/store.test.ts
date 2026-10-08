import { describe, expect, test } from 'claude-code/testing'

import { ageOf, eventForIncoming, findDuplicate, fold, isSubmissionOf, labelOf, similarity, submittedTask, words } from '../hooks/store'
import type { Task, TaskEvent } from '../hooks/store'

const REPO = { root: 'C:/dev/acme-storefront', name: 'acme-storefront' }

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add Windows path tests for sync-mcp',
    detail: 'Paths with spaces break',
    prompt: 'Add tests for sync-mcp on Windows where a server path contains spaces.',
    repo: REPO,
    kind: 'suggested',
    status: 'open',
    favourite: false,
    seen: 1,
    sources: [{ kind: 'chip', session: 's1', at: '2026-10-07T10:00:00.000Z' }],
    createdAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z',
    ...over,
  }
}

function add(t: Task, at = t.createdAt, by = 's1'): TaskEvent {
  return { v: 1, at, by, op: 'add', task: t }
}

describe('fold', () => {
  test('applies events in time order, whichever log they came from', () => {
    const events: TaskEvent[] = [
      { v: 1, at: '2026-10-07T12:00:00.000Z', by: 's2', op: 'set', id: 't1', fields: { favourite: true } },
      add(task()),
      { v: 1, at: '2026-10-07T11:00:00.000Z', by: 's1', op: 'set', id: 't1', fields: { favourite: false, title: 'Renamed' } },
    ]
    const [only] = fold(events)
    expect(only?.favourite).toBe(true)
    expect(only?.title).toBe('Renamed')
    expect(only?.updatedAt).toBe('2026-10-07T12:00:00.000Z')
  })

  test('a merge counts a sighting and keeps its source', () => {
    const source = { kind: 'tool' as const, session: 's2', at: '2026-10-07T11:00:00.000Z' }
    const [only] = fold([add(task()), { v: 1, at: source.at, by: 's2', op: 'merge', id: 't1', source }])
    expect(only?.seen).toBe(2)
    expect(only?.sources).toHaveLength(2)
  })

  test('ignores a second add of the same id and events for unknown ids', () => {
    const list = fold([
      add(task()),
      add(task({ title: 'Other' }), '2026-10-07T11:00:00.000Z'),
      { v: 1, at: '2026-10-07T12:00:00.000Z', by: 's1', op: 'set', id: 'missing', fields: { status: 'done' } },
    ])
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Add Windows path tests for sync-mcp')
  })
})

describe('duplicates', () => {
  test('words drops case, punctuation, stopwords and plurals', () => {
    expect(words('Add the Windows path-tests for sync-mcp!')).toEqual(['add', 'window', 'path', 'test', 'sync', 'mcp'])
  })

  test('same words in the same project is exact', () => {
    const match = findDuplicate({ title: 'add windows path tests for SYNC-MCP', repo: REPO }, [task()])
    expect(match?.match).toBe('exact')
  })

  test('mostly the same words is near; a different project is never a match', () => {
    expect(similarity('Add Windows path tests for sync-mcp', 'Add path tests for sync-mcp on Windows machines')).toBeGreaterThanOrEqual(0.75)
    expect(findDuplicate({ title: 'Add Windows path tests for sync-mcp on Windows machines', repo: REPO }, [task()])?.match).toBe('near')
    expect(findDuplicate({ title: 'Add Windows path tests for sync-mcp', repo: { root: 'C:/dev/other', name: 'other' } }, [task()])).toBeNull()
  })

  test('steps of one plan never merge with each other, however alike', () => {
    const plan = { id: 'p1', title: 'Ship', step: 1, of: 3 }
    const first = task({ title: 'Live check plan: first step', kind: 'plan', plan })
    expect(findDuplicate({ title: 'Live check plan: second step', repo: REPO, plan: { ...plan, step: 2 } }, [first])).toBeNull()
  })

  test('one meaningful word apart is not a near duplicate', () => {
    expect(findDuplicate({ title: 'Add docs for sync-mcp', repo: REPO }, [task({ title: 'Add tests for sync-mcp' })])).toBeNull()
  })

  test('done tasks and unrelated titles are not duplicates', () => {
    expect(findDuplicate({ title: 'Add Windows path tests for sync-mcp', repo: REPO }, [task({ status: 'done' })])).toBeNull()
    expect(findDuplicate({ title: 'Write release notes', repo: REPO }, [task()])).toBeNull()
  })

  test('an incoming duplicate becomes a merge, anything else an add', () => {
    const repeat = task({ id: 't2', createdAt: '2026-10-07T11:00:00.000Z' })
    expect(eventForIncoming(repeat, [task()], 's2').op).toBe('merge')
    expect(eventForIncoming(task({ id: 't3', title: 'Write release notes' }), [task()], 's2').op).toBe('add')
  })
})

describe('labels, submission and age', () => {
  test('labels by kind', () => {
    expect(labelOf(task())).toBe('Suggested')
    expect(labelOf(task({ kind: 'added' }))).toBe('Added')
    expect(labelOf(task({ kind: 'plan', plan: { id: 'p', title: 'Ship', step: 2, of: 4 } }))).toBe('Plan 2/4')
  })

  test('a sent prompt matches a task by its opening, edits after it allowed', () => {
    const t = task({ prompt: 'Add tests for sync-mcp on Windows where a server path contains spaces. Keep macOS passing.' })
    expect(isSubmissionOf(t.prompt, t)).toBe(true)
    expect(isSubmissionOf(`${t.prompt.slice(0, 85)}  and also check Linux.`, t)).toBe(true)
    expect(isSubmissionOf('Add tests for something else entirely', t)).toBe(false)
  })

  test('a short prompt has to be sent exactly', () => {
    const t = task({ prompt: 'Fix lint' })
    expect(isSubmissionOf('fix   LINT', t)).toBe(true)
    expect(isSubmissionOf('Fix lint errors in foo.ts', t)).toBe(false)
  })

  test('only a task in the same project is taken as sent, the longest opening first', () => {
    const long = task({ id: 'long', prompt: 'Add tests for sync-mcp on Windows where a server path contains spaces.' })
    const elsewhere = task({ id: 'elsewhere', prompt: long.prompt, repo: { root: 'C:/dev/other', name: 'other' } })
    const short = task({ id: 'short', prompt: 'Add tests for sync-mcp on Windows' + ' '.repeat(3) })
    expect(submittedTask(long.prompt, [elsewhere], REPO)).toBeNull()
    expect(submittedTask(long.prompt, [short, long, elsewhere], REPO)?.id).toBe('long')
  })

  test('titles in other scripts compare by their own words', () => {
    expect(words('Café crème')).toEqual(['café', 'crème'])
    expect(findDuplicate({ title: '修复登录错误', repo: REPO }, [task({ title: '添加单元测试' })])).toBeNull()
    expect(findDuplicate({ title: '!!!', repo: REPO }, [task({ title: '???' })])).toBeNull()
  })

  test('age reads now, minutes, hours, days, weeks', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    expect(ageOf('2026-10-07T11:59:30.000Z', now)).toBe('now')
    expect(ageOf('2026-10-07T11:55:00.000Z', now)).toBe('5m')
    expect(ageOf('2026-10-07T09:00:00.000Z', now)).toBe('3h')
    expect(ageOf('2026-10-05T12:00:00.000Z', now)).toBe('2d')
    expect(ageOf('2026-09-23T12:00:00.000Z', now)).toBe('2w')
  })
})
