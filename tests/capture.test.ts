import { describe, expect, test } from 'claude-code/testing'

import { listText, taskFromChip, tasksFromAddInput } from '../hooks/capture'
import type { Stamp } from '../hooks/capture'

const PROJECT = { root: 'C:/dev/acme-storefront', name: 'acme-storefront' }

function stamp(): Stamp {
  let n = 0
  return { session: 's1', now: '2026-10-07T10:00:00.000Z', newId: () => `id${++n}` }
}

describe('chips', () => {
  test('a chip becomes a Suggested task with its tldr as the detail', () => {
    const t = taskFromChip({ title: 'Fix stale README badge', tldr: 'The badge links a dead CI job.', prompt: 'Update the README badge to the new workflow.' }, PROJECT, stamp())
    expect(t?.kind).toBe('suggested')
    expect(t?.detail).toBe('The badge links a dead CI job.')
    expect(t?.prompt).toBe('Update the README badge to the new workflow.')
    expect(t?.repo).toEqual(PROJECT)
    expect(t?.sources[0]?.kind).toBe('chip')
  })

  test('a chip without a title or prompt is not kept', () => {
    expect(taskFromChip({ title: 'Only a title' }, PROJECT, stamp())).toBeNull()
    expect(taskFromChip({ prompt: 'Only a prompt' }, PROJECT, stamp())).toBeNull()
  })
})

describe('add_tasks', () => {
  test('tasks without a plan are Added, with title and details as the prompt', () => {
    const [t] = tasksFromAddInput({ tasks: [{ title: 'Write release notes', details: 'Cover the stop-all control.' }] }, PROJECT, stamp())
    expect(t?.kind).toBe('added')
    expect(t?.prompt).toBe('Write release notes\n\nCover the stop-all control.')
  })

  test('a plan numbers its steps in order and shares one plan id', () => {
    const list = tasksFromAddInput({ plan: { title: 'Ship Next Up' }, tasks: [{ title: 'Store' }, { title: 'Capture' }, { title: 'UI' }] }, PROJECT, stamp())
    expect(list.map(t => t.plan?.step)).toEqual([1, 2, 3])
    expect(list.every(t => t.kind === 'plan' && t.plan?.of === 3)).toBe(true)
    expect(new Set(list.map(t => t.plan?.id)).size).toBe(1)
    expect(list[1]?.detail).toBe('Ship Next Up, step 2 of 3')
  })

  test('an explicit prompt wins, and untitled items are skipped', () => {
    const list = tasksFromAddInput({ tasks: [{ title: 'A', prompt: 'Full prompt for A' }, { details: 'no title' }] }, PROJECT, stamp())
    expect(list).toHaveLength(1)
    expect(list[0]?.prompt).toBe('Full prompt for A')
  })
})

describe('listText', () => {
  test('lists open tasks for the project, favourites first', () => {
    const [a, b] = tasksFromAddInput({ tasks: [{ title: 'First' }, { title: 'Second' }] }, PROJECT, stamp())
    if (!a || !b) throw new Error('setup')
    const text = listText([a, { ...b, favourite: true }, { ...a, id: 'gone', status: 'done' }], PROJECT, 'project')
    expect(text.split('\n')).toHaveLength(2)
    expect(text.split('\n')[0]).toContain('★ Second')
  })

  test('says so when empty', () => {
    expect(listText([], PROJECT, 'project')).toBe('No open tasks for acme-storefront.')
    expect(listText([], null, 'all')).toBe('Next Up is empty.')
  })
})
