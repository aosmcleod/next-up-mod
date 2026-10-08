import { describe, expect, test } from 'claude-code/testing'

import { applyChanges, editsNote, openReminder, sessionText, tasksLabel, tasksView } from '../hooks/session'
import type { SessionTask } from '../hooks/session'

const T0 = '2026-10-08T10:00:00.000Z'
const T1 = '2026-10-08T10:05:00.000Z'
const T2 = '2026-10-08T10:09:00.000Z'

const planned = () =>
  applyChanges([], { add: [{ title: 'Read the cart code' }, { title: '  Fix   rounding ', details: 'per line' }, { title: '' }, { title: 'Add a test' }] }, T0).tasks

describe('applying Claude’s changes', () => {
  test('adds in order with short ids, skipping empty titles', () => {
    const tasks = planned()
    expect(tasks.map(t => [t.id, t.title, t.status])).toEqual([
      ['s1', 'Read the cart code', 'todo'],
      ['s2', 'Fix rounding', 'todo'],
      ['s3', 'Add a test', 'todo'],
    ])
    expect(tasks[1]?.detail).toBe('per line')
  })

  test('marks done, removes, and reports unknown ids', () => {
    const { tasks, unknown } = applyChanges(planned(), { done: ['s1', 's9'], remove: ['s2'] }, T1)
    expect(tasks.map(t => [t.id, t.status])).toEqual([['s1', 'done'], ['s2', 'removed'], ['s3', 'todo']])
    expect(sessionText(tasks)).not.toContain('s2')
    expect(tasks[0]?.doneAt).toBe(T1)
    expect(unknown).toEqual(['s9'])
  })

  test('ids are never reused after a removal', () => {
    const { tasks } = applyChanges(applyChanges(planned(), { remove: ['s3'] }, T1).tasks, { add: [{ title: 'Next' }] }, T1)
    expect(tasks.at(-1)?.id).toBe('s4')
    expect(applyChanges(tasks, { done: ['s3'] }, T2).unknown).toEqual(['s3'])
    const again = applyChanges(planned(), { add: [{ title: 'Fourth' }] }, T1).tasks
    expect(again.at(-1)?.id).toBe('s4')
  })

  test('rewords a step in place, keeping what is not given', () => {
    const { tasks, unknown } = applyChanges(planned(), { update: [{ id: 's2', title: 'Fix rounding per line' }, { id: 's3', details: 'one case' }, { id: 's7', title: 'x' }] }, T1)
    expect(tasks.map(t => [t.id, t.title, t.detail])).toEqual([
      ['s1', 'Read the cart code', ''],
      ['s2', 'Fix rounding per line', 'per line'],
      ['s3', 'Add a test', 'one case'],
    ])
    expect(unknown).toEqual(['s7'])
  })

  test('marking a done task done again keeps its first time', () => {
    const once = applyChanges(planned(), { done: ['s1'] }, T1).tasks
    expect(applyChanges(once, { done: ['s1'] }, T2).tasks[0]?.doneAt).toBe(T1)
  })
})

describe('what Claude reads', () => {
  test('the list text groups to do and done', () => {
    const tasks = applyChanges(planned(), { done: ['s1'] }, T1).tasks
    expect(sessionText(tasks)).toBe(['To do (2):', '- [s2] Fix rounding: per line', '- [s3] Add a test', 'Done (1):', '- [s1] Read the cart code'].join('\n'))
    expect(sessionText([])).toBe('The session task list is empty.')
  })

  test('the edits note names what the user did, or is null', () => {
    const tasks = planned()
    expect(editsNote(tasks, { done: [], removed: [] })).toBeNull()
    const after = applyChanges(tasks, { remove: ['s1'] }, T1).tasks
    const note = editsNote(after, { done: [], removed: [tasks[0] as SessionTask] }) ?? ''
    expect(note).toContain('Removed by the user: [s1] Read the cart code.')
    expect(note).toContain('- [s2] Fix rounding')
    expect(note).not.toContain('- [s1]')
  })
})

test('the reminder lists what is left in order, or is null', () => {
  const tasks = applyChanges(planned(), { done: ['s1'] }, T1).tasks
  const reminder = openReminder(tasks) ?? ''
  expect(reminder).toContain('still to do (2)')
  expect(reminder.split('\n').slice(1)).toEqual(['- [s2] Fix rounding', '- [s3] Add a test'])
  expect(openReminder(applyChanges(tasks, { done: ['s2', 's3'] }, T2).tasks)).toBeNull()
})

describe('the footer and pane', () => {
  test('the footer counts what is left', () => {
    expect(tasksLabel([])).toBe('Tasks ↗')
    expect(tasksLabel(applyChanges(planned(), { done: ['s1'] }, T1).tasks)).toBe('2 \u00a0Tasks ↗')
  })

  test('to do keeps planned order; done is newest first', () => {
    let tasks = applyChanges(planned(), { done: ['s3'] }, T1).tasks
    tasks = applyChanges(tasks, { done: ['s1'] }, T2).tasks
    expect(tasksView(tasks, 'todo').items.map(t => t.id)).toEqual(['s2'])
    expect(tasksView(tasks, 'done').items.map(t => t.id)).toEqual(['s1', 's3'])
    expect(tasksView(tasks, 'todo').tabs.map(t => t.label)).toEqual(['To Do 1', 'Done 2'])
  })
})
