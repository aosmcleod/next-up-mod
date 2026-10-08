import { describe, expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { bandTasks, footerLabel, labelColour, paneView, AMBER, BLUE, PURPLE } from '../hooks/view'

const STOREFRONT = { root: 'C:/dev/acme-storefront', name: 'acme-storefront' }
const BILLING = { root: 'C:/dev/billing-api', name: 'billing-api' }

let n = 0
function task(over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `t${n}`, title: `Task ${n}`, detail: '', prompt: `Prompt ${n}`, repo: STOREFRONT, kind: 'added',
    status: 'open', favourite: false, seen: 1, sources: [],
    createdAt: `2026-10-07T10:${String(n).padStart(2, '0')}:00.000Z`, updatedAt: '2026-10-07T10:00:00.000Z',
    ...over,
  }
}

describe('footer', () => {
  test('counts open tasks in the project, or every open task outside one', () => {
    const list = [task(), task(), task({ repo: BILLING }), task({ status: 'done' })]
    expect(footerLabel(list, STOREFRONT)).toBe('2 \u00a0Next Up ↗')
    expect(footerLabel(list, null)).toBe('3 \u00a0Next Up ↗')
    expect(footerLabel([], STOREFRONT)).toBe('Next Up ↗')
  })
})

describe('pane', () => {
  test('tabs are ★, the project, All; no project tab outside a project', () => {
    const list = [task({ favourite: true }), task({ repo: BILLING })]
    expect(paneView(list, STOREFRONT, 'project').tabs.map(t => t.label)).toEqual(['★ 1', 'acme-storefront 1', 'All 2'])
    const outside = paneView(list, null, 'project')
    expect(outside.tabs.map(t => t.id)).toEqual(['favourites', 'all'])
    expect(outside.current).toBe('all')
  })

  test('the project tab lists its cards, favourites first, no headers', () => {
    const plain = task()
    const fav = task({ favourite: true })
    const view = paneView([plain, fav], STOREFRONT, 'project')
    expect(view.items.map(i => (i.kind === 'card' ? i.task.id : i.name))).toEqual([fav.id, plain.id])
  })

  test('All groups by project: this project first, then by name, No project last', () => {
    const list = [task({ repo: BILLING }), task({ repo: null }), task({ repo: { root: 'C:/dev/alpha', name: 'alpha' } }), task()]
    const headers = paneView(list, STOREFRONT, 'all').items.filter(i => i.kind === 'header').map(i => (i.kind === 'header' ? i.name : ''))
    expect(headers).toEqual(['acme-storefront', 'alpha', 'billing-api', 'No project'])
  })

  test('two clones with one folder name stay apart, and only this one sorts first', () => {
    const other = { root: 'C:/elsewhere/acme-storefront', name: 'acme-storefront' }
    const list = [task(), task({ repo: other })]
    const headers = paneView(list, STOREFRONT, 'all').items.flatMap(i => (i.kind === 'header' ? [i.key] : []))
    expect(headers).toEqual(['C:/dev/acme-storefront', 'C:/elsewhere/acme-storefront'])
  })
})

describe('band and labels', () => {
  test('the band shows up to three open tasks for the project, favourites first', () => {
    const list = [task(), task(), task(), task({ favourite: true }), task({ repo: BILLING })]
    const shown = bandTasks(list, STOREFRONT)
    expect(shown).toHaveLength(3)
    expect(shown[0]?.favourite).toBe(true)
    expect(shown.every(t => t.repo?.root === STOREFRONT.root)).toBe(true)
  })

  test('label colours: plan amber, added blue, suggested purple', () => {
    expect(labelColour(task({ kind: 'plan' }))).toBe(AMBER)
    expect(labelColour(task({ kind: 'added' }))).toBe(BLUE)
    expect(labelColour(task({ kind: 'suggested' }))).toBe(PURPLE)
  })
})
