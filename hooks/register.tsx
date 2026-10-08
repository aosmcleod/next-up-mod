import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Project, SessionTask, Tab, Task, TasksTab } from '../types'
import { listText, taskFromChip, tasksFromAddInput } from './capture'
import { applyChanges, editsNote, openReminder, sessionText, tasksLabel, tasksView } from './session'
import type { SessionChanges, UserEdits } from './session'
import type { AddInput, Stamp } from './capture'
import { ageOf, eventForIncoming, fold, labelOf, submittedTask } from './store'
import type { TaskEvent } from './store'
import { appendEvents, logsSignature, readEvents } from './store-io'
import type { Files, LogCache } from './store-io'
import { bandTasks, cap, detailCap, footerLabel, labelColour, paneView, AMBER } from './view'

// Next Up's hooks, for its two features (each can be switched off in /config):
//
// - The backlog: follow-ups come in from Claude's suggestion chips and its
//   add_tasks tool, are kept in per-session logs shared by every session, and
//   are shown by a footer button, a pane and (on request) a band above the
//   prompt. Sending a task's prompt marks it done.
// - Tasks: a list Claude keeps for multi-step work in this session through
//   update_session_tasks, shown by a footer button and a pane. The user's edits
//   there reach Claude with their next prompt.
//
// Desktop limits this works within: cards are plain trees, not Client regions
// (each Client boots its own frame, so a pane of them is slow to appear); only
// native Buttons take clicks and they cannot be coloured; every state write
// redraws every site, so state is written only when it changes.

const PLUGIN = 'next-up'
const PANE = 'next-up'
const TASKS_PANE = 'next-up-tasks'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`
const POLL_MS = 30_000
const NEW_PROMPT_MAX = 4000

const HOVER = '#2a2a2a'
// Fully transparent, so a card's round border can sit there at rest unseen.
const CLEAR = '#00000000'
const TRAY = '#1f1f1f'
const RULE = '#4a4a4a'
const MUTED_RED = '#c0605a'
const GREEN = '#6fbf73'
// The trash can as a text glyph (U+FE0E asks for text, not emoji, presentation),
// so it takes the button's hover colour.
const TRASH = '\u{1F5D1}\uFE0E'
// The band's Now slot: wide enough for the "Now ↓" button.
const BAND_NOW_COLUMNS = 8
// On hover a card's text fades to this, behind its buttons.
const FADE = { color: '#5e5e5e', dimColor: false }

// What Claude is told, per feature: file worthwhile follow-ups in the backlog
// instead of trailing them at the end of a reply; keep a list for multi-step
// work in the session.
const NUDGE_BACKLOG = [
  '# Next Up',
  'The user keeps a shared backlog of follow-up work across their Claude sessions, called Next Up.',
  `When you notice worthwhile work outside the current task (a bug spotted in passing, a missing test, a docs gap, a refactor worth doing later), add it with the ${TOOL('add_tasks')} tool rather than only mentioning it.`,
  'Give each task a short imperative title and a self-contained prompt another session could act on without this conversation.',
  'Do not add the current task, trivial items, or anything the user has just declined. Do not announce that you added them.',
  `When the user asks you to add something to Next Up, or to plan work into it, use ${TOOL('add_tasks')}; for a plan, pass a plan title and list the steps in order.`,
].join('\n')

const NUDGE_TASKS = [
  '# Session tasks',
  `For work in this session that takes two or more steps, keep a task list with ${TOOL('update_session_tasks')}. The user watches it in a Tasks pane.`,
  '- Before starting, add the steps you plan from the request.',
  '- Work through it in order. When a step is finished, mark it done right away, then take the next one.',
  '- Keep it true: add steps as you find them, reword ones that changed, remove ones that no longer apply.',
  '- Before ending your turn, check the list. If steps remain and nothing blocks them, carry on; otherwise say which remain and why.',
  '- Skip it for questions and single-step changes. Use it instead of any other todo or task-list tool, so there is one list.',
  '- While steps remain, the open ones come with each user message. The user can also mark steps done or remove them; you are told with their next message. Treat those changes as decided.',
].join('\n')

// The two features, each switched in the plugin's settings (/config). Read
// when the module loads, so a change applies from the next session or reload.
const features = { backlog: true, tasks: true }

// The guidance for the features switched on, narrowed to the tools a request
// offers when that is known (a subagent may be given fewer).
function nudgeText(tools?: readonly string[]): string {
  const offers = (name: string) => !tools || tools.includes(TOOL(name))
  const backlog = features.backlog && offers('add_tasks') ? NUDGE_BACKLOG : ''
  const tasks = features.tasks && offers('update_session_tasks') ? NUDGE_TASKS : ''

  return [backlog, tasks].filter(Boolean).join('\n\n')
}

const tasksAtom = atom({ plugin: 'next-up', key: 'tasks' } as const, [] as Task[])
const projectAtom = atom({ plugin: 'next-up', key: 'project' } as const, null as Project)
const tabAtom = atom({ plugin: 'next-up', key: 'tab' } as const, 'project' as Tab)
const bandAtom = atom({ plugin: 'next-up', key: 'band' } as const, false)
const sessionAtom = atom({ plugin: 'next-up', key: 'session' } as const, [] as SessionTask[])
const tasksTabAtom = atom({ plugin: 'next-up', key: 'tasksTab' } as const, 'todo' as TasksTab)

// What the user changed in the Tasks pane since Claude last saw the list; sent
// with the next prompt, then cleared.
const edits: UserEdits = { done: [], removed: [] }

// Whether Claude has been told about Next Up this session: through the system
// prompt where the engine composes it after Next Up starts (the terminal), or
// else beside the first prompt sent (desktop, where no mod runs until the
// first message and the system prompt is already built).
const nudge = { composed: false, sent: false }

// Repeat presses of the same button on the same task within this window are one.
const REPEAT_MS = 1000
const lastPress = new Map<string, number>()

type Platform = 'windows' | 'macos' | 'linux'

// Session-wide context, set at session start (a reload sets it again).
const context = { session: '', dir: '', cwd: '', project: null as Project, platform: 'macos' as Platform }
// The folded list, the log signature it was read at, and each log's events.
const cache = { signature: '\u0000', tasks: [] as Task[], logs: new Map() as LogCache }

function stamp(): Stamp {
  return { session: context.session, now: new Date().toISOString(), newId: () => crypto.randomUUID() }
}

// Where the logs live: ~/.claude/next-up.
async function dataDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'

  return `${home.replace(/\\/g, '/')}/.claude/next-up`
}

// The file operations the store uses. ($ may not cross an import, so the
// store-io functions get these instead of $.fs itself.)
function filesOf($: EngineInterface): Files {
  return {
    exists: path => $.fs.exists(path),
    list: path => $.fs.list(path),
    read: ((path: string) => $.fs.read(path)) as Files['read'],
    write: (path, text) => $.fs.write(path, text),
  }
}

// The project a folder belongs to: its git root, or null outside one (or
// where git is not installed).
async function projectOf($: EngineInterface, folder: string): Promise<Project> {
  const ran = await $.process.run(['git', '-C', folder, 'rev-parse', '--show-toplevel']).catch(() => null)
  const root = ran?.exitCode === 0 ? ran.stdout.trim().replace(/\\/g, '/') : ''

  return root ? { root, name: root.split('/').pop() ?? root } : null
}

// Windows sets OS for every process; elsewhere uname tells macOS from Linux.
async function platformOf($: EngineInterface): Promise<Platform> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const ran = await $.process.run(['uname', '-s']).catch(() => null)

  return ran?.stdout.trim() === 'Darwin' ? 'macos' : 'linux'
}

async function setProject($: EngineInterface, project: Project) {
  context.project = project
  if ((await read($, projectAtom))?.root !== project?.root) await update($, projectAtom, () => project)
}

// Re-reads the logs when any changed, and only then writes the list to state
// (a state write redraws every site, which drops clicks in flight).
async function refresh($: EngineInterface): Promise<Task[]> {
  const signature = await logsSignature(filesOf($), context.dir)
  if (signature !== cache.signature) {
    cache.tasks = fold(await readEvents(filesOf($), context.dir, cache.logs))
    cache.signature = signature
    await update($, tasksAtom, () => cache.tasks)
  }

  return cache.tasks
}

// This session's writes, one at a time. Appending rewrites the session's log,
// so two hooks writing at once (two chips in one turn, quick clicks on two
// cards) would otherwise both start from the same copy and one would be lost.
let writes: Promise<unknown> = Promise.resolve()

function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work, work)
  writes = run.catch(() => undefined)

  return run
}

async function record($: EngineInterface, events: TaskEvent[]) {
  await appendEvents(filesOf($), context.dir, context.session, events)
  await refresh($)
}

// Adds incoming tasks, merging each into an open duplicate where there is one
// (within the batch too). Returns how many were new and how many merged.
// The read and the write run together in the queue, so a duplicate arriving at
// the same moment sees this batch.
function addIncoming($: EngineInterface, incoming: Task[]): Promise<{ added: Task[]; merged: number }> {
  return serially(() => addNow($, incoming))
}

async function addNow($: EngineInterface, incoming: Task[]): Promise<{ added: Task[]; merged: number }> {
  const known = [...(await refresh($))]
  const events: TaskEvent[] = []
  const added: Task[] = []
  for (const task of incoming) {
    const event = eventForIncoming(task, known, context.session)
    events.push(event)
    if (event.op === 'add') {
      known.push(task)
      added.push(task)
    }
  }
  await record($, events)

  return { added, merged: incoming.length - added.length }
}

function setFields($: EngineInterface, id: string, fields: Extract<TaskEvent, { op: 'set' }>['fields']): Promise<void> {
  return serially(() => record($, [{ v: 1, at: new Date().toISOString(), by: context.session, op: 'set', id, fields }]))
}

async function togglePane($: EngineInterface, id = PANE, title = 'Next Up') {
  const isOpen = (await $.ui.panes()).some(p => p.id === id)
  if (isOpen) await $.ui.close({ id })
  else await $.ui.open({ id, title })
}

// The session list's changes, from Claude's tool or the pane, applied in order.
// The change is applied to the list as it stands when the write lands, so a
// press and a tool call at the same moment never overwrite each other.
async function changeSession($: EngineInterface, changes: SessionChanges): Promise<{ tasks: SessionTask[]; unknown: string[] }> {
  let result: { tasks: SessionTask[]; unknown: string[] } = { tasks: [], unknown: [] }
  const now = new Date().toISOString()
  await update($, sessionAtom, prev => {
    result = applyChanges(prev ?? [], changes, now)
    return result.tasks
  })

  return result
}

// A press in the Tasks pane: applied, and remembered for Claude's next prompt.
async function editSession($: EngineInterface, op: 'done' | 'remove', id: string) {
  // A slow desktop can deliver several queued clicks at once; act on the first.
  const now = Date.now()
  const pressKey = `session-${op}:${id}`
  if (now - (lastPress.get(pressKey) ?? 0) < REPEAT_MS) return
  lastPress.set(pressKey, now)
  const task = ((await read($, sessionAtom)) ?? []).find(t => t.id === id)
  if (!task || task.status !== 'todo') return
  await changeSession($, op === 'done' ? { done: [id] } : { remove: [id] })
  if (op === 'done') edits.done.push(task)
  else edits.removed.push(task)
}

// For a button: runs the press, and says so if it fails rather than failing silently.
function press($: EngineInterface, work: Promise<unknown>) {
  void work.catch(() => $.ui.toast('Next Up: that did not work, try again'))
}

// Opens the desktop app's new-session screen in the task's project with its
// prompt in the box, unsent: claude://code/new?q=<prompt>&folder=<path>. The
// desktop app runs on macOS and Windows only.
async function newSession($: EngineInterface, task: Task) {
  if (context.platform === 'linux') {
    $.ui.toast('Next Up: New needs the Claude desktop app (macOS or Windows). Use Now instead.')
    return
  }
  const root = task.repo?.root ?? context.cwd
  const folder = context.platform === 'windows' ? root.replace(/\//g, '\\') : root
  // Links this long are cut by some URL handlers; the opening that marks the
  // task done on send survives the cut.
  const prompt = task.prompt.slice(0, NEW_PROMPT_MAX)
  const url = `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`
  const argv = context.platform === 'windows' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['open', url]
  const ran = await $.process.run(argv).catch(() => null)
  if (ran?.exitCode !== 0) $.ui.toast("Next Up: couldn't open a new session")
}

async function act($: EngineInterface, action: 'now' | 'new' | 'favourite' | 'delete', id: string) {
  // A slow desktop can deliver several queued clicks at once; act on the first.
  const now = Date.now()
  const pressKey = `${action}:${id}`
  if (now - (lastPress.get(pressKey) ?? 0) < REPEAT_MS) return
  lastPress.set(pressKey, now)
  const task = cache.tasks.find(t => t.id === id)
  if (!task) return
  try {
    if (action === 'now') await $.prompt.fill({ text: task.prompt, mode: 'replace' })
    if (action === 'new') await newSession($, task)
    if (action === 'favourite') await setFields($, id, { favourite: !task.favourite })
    if (action === 'delete') await setFields($, id, { status: 'dropped' })
  } catch {
    $.ui.toast(`Next Up: couldn't ${action === 'favourite' ? 'update' : action} "${task.title}"`)
  }
}

type CardModel = {
  // Unique per site, so the band and the panes never share a key.
  key: string
  title: string
  detail: string
  favourite?: boolean
  // A finished task: the title struck through.
  struck?: boolean
  // Top right, in order: the kind or Done in colour, or an age (dim).
  topRight: Array<{ text: string; colour?: string }>
  // Bottom right in a pane: the age, where the top right holds a label.
  bottomRight?: string
}

type CardOptions = {
  site: 'band' | 'pane'
  // The width the card draws into, for the three-line description cap.
  columns: number
  // The band's one button, shown on hover in a fixed slot at the bottom right.
  slot?: RenderChildren
  // The pane's buttons, shown on hover on a tray centred over the card.
  tray?: RenderChildren
  // No buttons and no hover: a card only to read.
  still?: boolean
}

// One card, shared by the band and both panes:
//
//   ★ Title, cut so the label always fits ................... Suggested
//     Description, about three lines ........................... 2d
//
// On hover the text fades and the buttons sit centred on a solid tray over it,
// so nothing reflows.
function card(els: Elements['desktop'], m: CardModel, o: CardOptions) {
  const { Box, Text } = els
  // A still card (a finished task) has nothing to press, so no hover either.
  const fade = o.still ? undefined : FADE

  return (
    // Always bordered (round), transparent at rest and the hover colour on
    // hover, so the hover reads as a rounded card and nothing reflows. Half a
    // cell short of the edges, so the corners are not clipped (the right one
    // also clears the pane's scrollbar).
    <Box
      key={m.key}
      flexDirection="column"
      marginLeft={-0.5}
      marginRight={-0.5}
      paddingLeft={1}
      paddingRight={1}
      position="relative"
      borderStyle="round"
      borderColor={CLEAR}
      hover={o.still ? undefined : { backgroundColor: HOVER, borderColor: HOVER }}
    >
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Box flexDirection="row" flexShrink={1} minWidth={0}>
          {m.favourite ? <Text color={AMBER} bold hover={fade}>★ </Text> : null}
          <Text wrap="truncate-end" strikethrough={m.struck} dimColor={m.struck} hover={fade}>{m.title}</Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} gap={2}>
          {m.topRight.map(part =>
            part.colour ? (
              <Text key={part.text} color={part.colour} hover={fade && { color: FADE.color }}>{part.text}</Text>
            ) : (
              <Text key={part.text} dimColor hover={fade}>{part.text}</Text>
            ),
          )}
        </Box>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" alignItems={o.site === 'band' ? 'flex-end' : 'flex-start'} gap={2}>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="wrap" hover={fade}>{cap(m.detail, detailCap(o.columns))}</Text>
        </Box>
        {o.site === 'band' ? (
          // The band draws any floating box as a popover with its own frame, so
          // its button lives in a fixed-size slot at the bottom right instead:
          // empty at rest, the button on hover, and the slot's size never changes.
          <Box width={BAND_NOW_COLUMNS} height={1} flexShrink={0} justifyContent="flex-end">
            <Box display="none" hover={{ display: 'flex' }}>{o.slot}</Box>
          </Box>
        ) : m.bottomRight ? (
          <Box flexShrink={0}>
            <Text dimColor hover={fade}>{m.bottomRight}</Text>
          </Box>
        ) : null}
      </Box>
      {o.site === 'band' || o.still ? null : (
        <Box position="absolute" top={0} bottom={0} left={0} right={0} display="none" hover={{ display: 'flex' }} flexDirection="row" justifyContent="center" alignItems="center">
          {/* A solid tray, so the translucent native buttons read as solid. */}
          <Box flexDirection="row" gap={1} paddingX={1} borderStyle="round" borderColor={TRAY} backgroundColor={TRAY}>
            {o.tray}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// A Next Up task's card: Now (band); Now, New, favourite and delete (pane).
function backlogCard($: EngineInterface, els: Elements['desktop'], task: Task, site: 'band' | 'pane', showProject: boolean, columns: number) {
  const { Button } = els
  const key = `${site}-${task.id}`
  const age = ageOf(task.createdAt, Date.now())
  const label = { text: labelOf(task), colour: labelColour(task) }
  const model: CardModel = {
    key,
    title: task.title,
    detail: showProject && task.repo ? `${task.repo.name} · ${task.detail}` : task.detail,
    favourite: task.favourite,
    // The band puts the age before the label; the pane puts it below.
    topRight: site === 'band' ? [{ text: age }, label] : [label],
    bottomRight: site === 'band' ? undefined : age,
  }
  if (site === 'band') {
    return card(els, model, { site, columns, slot: <Button key={`${key}-now`} label="Now ↓" variant="primary" onPress={() => void act($, 'now', task.id)} /> })
  }

  return card(els, model, {
    site,
    columns,
    tray: [
      <Button key={`${key}-now`} label="↙ Now" variant="primary" onPress={() => void act($, 'now', task.id)} />,
      <Button key={`${key}-new`} label="New ↗" onPress={() => void act($, 'new', task.id)} />,
      <Button key={`${key}-fav`} label={task.favourite ? '★' : '☆'} hover={{ color: AMBER }} onPress={() => void act($, 'favourite', task.id)} />,
      <Button key={`${key}-delete`} label={TRASH} hover={{ color: MUTED_RED }} onPress={() => void act($, 'delete', task.id)} />,
    ],
  })
}

// A session task's card: "To do" in amber or "Done" in green with the title
// struck, and below it when it was planned or finished. Buttons: Done (to do
// only) and delete; a finished task's card has none.
function sessionCard($: EngineInterface, els: Elements['desktop'], task: SessionTask, columns: number) {
  const { Button } = els
  const key = `tasks-${task.id}`
  const isDone = task.status === 'done'
  const model: CardModel = {
    key,
    title: task.title,
    detail: task.detail,
    struck: isDone,
    topRight: [isDone ? { text: 'Done', colour: GREEN } : { text: 'To do', colour: AMBER }],
    // When it was finished, or when it was planned.
    bottomRight: ageOf(isDone ? (task.doneAt ?? task.createdAt) : task.createdAt, Date.now()),
  }

  if (isDone) return card(els, model, { site: 'pane', columns, still: true })

  return card(els, model, {
    site: 'pane',
    columns,
    tray: [
      <Button key={`${key}-done`} label="✓ Done" variant="primary" onPress={() => press($, editSession($, 'done', task.id))} />,
      <Button key={`${key}-delete`} label={TRASH} hover={{ color: MUTED_RED }} onPress={() => press($, editSession($, 'remove', task.id))} />,
    ],
  })
}

async function registerBacklogTools($: EngineInterface) {
  await $.tool.register({
    name: 'add_tasks',
    description:
      "Add tasks to the user's Next Up backlog: follow-up work shared across all their Claude sessions. " +
      'Use it when the user asks to add something to Next Up or to plan work into it, and for worthwhile follow-ups outside the current task. ' +
      'Each task needs a short imperative title; give a self-contained prompt another session could act on, or details to build one from. ' +
      'Pass plan.title to group the tasks as the ordered steps of one plan.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short and imperative, under 80 characters.' },
              details: { type: 'string', description: 'A one- to three-line summary shown on the card.' },
              prompt: { type: 'string', description: 'The full prompt to send when the task is started. Defaults to title plus details.' },
            },
            required: ['title'],
          },
        },
        plan: { type: 'object', properties: { title: { type: 'string' } }, description: 'Group the tasks as the ordered steps of one plan.' },
      },
      required: ['tasks'],
    },
  })
  await $.tool.register({
    name: 'list_tasks',
    description: "List the open tasks in the user's Next Up backlog, for the current project or all projects, with their ids.",
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['project', 'all'] } } },
  })
  await $.tool.register({
    name: 'update_task',
    description: 'Update one Next Up task by id: mark it done or dropped, reopen it, or set it as a favourite. Use when you have finished a task that came from Next Up.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'dropped'] },
        favourite: { type: 'boolean' },
      },
      required: ['id'],
    },
  })
}

async function registerTasksTools($: EngineInterface) {
  await $.tool.register({
    name: 'update_session_tasks',
    description:
      'Keep the task list for the work in this session, shown to the user in a Tasks pane. ' +
      'add appends steps in order; update rewords steps; done and remove take ids (s1, s2, ...). Call with no changes to read the list. ' +
      'Returns the current list.' +
      (features.backlog ? ' This is separate from the Next Up backlog, which is for work outside this session.' : ''),
    inputSchema: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short and imperative, under 80 characters.' },
              details: { type: 'string', description: 'Optional: one line on what the step involves.' },
            },
            required: ['title'],
          },
        },
        update: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, title: { type: 'string' }, details: { type: 'string' } },
            required: ['id'],
          },
          description: 'Reword steps by id: a new title, details, or both.',
        },
        done: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks now finished.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks no longer needed.' },
      },
    },
  })
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// What /next does, for the commands list: only the features switched on.
function commandHelp(): string {
  if (!features.backlog) return 'Next Up: open the Tasks pane'
  return features.tasks
    ? 'Next Up: open the pane; `/next tasks`, `/next list`, `/next all`, `/next band`, or `/next plan <goal>`'
    : 'Next Up: open the pane; `/next list`, `/next all`, `/next band`, or `/next plan <goal>`'
}

// /next plan <goal>: asks Claude, as a turn of its own, to plan into Next Up.
function planPrompt(goal: string) {
  return `Plan this into my Next Up backlog: ${goal}\n\nBreak it into a few ordered steps and add them with ${TOOL('add_tasks')}, passing a plan title. Give each step a self-contained prompt. Do not start the work.`
}

// Next Up sits in the path of session start, Claude's suggestion chips and
// every sent prompt. If one of its hooks fails, the catch below lets the event
// carry on as if Next Up were not there.
export const register: Register = (on, options) => {
  features.backlog = options.backlog !== false
  features.tasks = options.tasks !== false
  if (!features.backlog && !features.tasks) return

  on('session.start', async ($, e, next) => {
    context.session = await $.session.id()
    context.dir = await dataDir($)
    context.cwd = e.cwd
    nudge.composed = false
    nudge.sent = false
    // The tools and command first: the nudge tells Claude about them, so they
    // must exist even if what follows fails.
    // Each step on its own, so one failing does not take the others with it.
    await $.command.register({ name: 'next', description: commandHelp() }).catch(() => undefined)
    if (features.tasks) await registerTasksTools($).catch(() => undefined)
    if (!features.backlog) return next(e)
    await registerBacklogTools($).catch(() => undefined)
    context.platform = await platformOf($)
    await setProject($, await projectOf($, e.cwd))
    await refresh($)
    // Other sessions write their own logs; pick their changes up. A failed
    // poll is retried on the next tick.
    $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))
    // The session-start list is off by default: on desktop no mod runs until the
    // first message is sent, so it could only flash and vanish as that prompt
    // arrives. /next band shows it on demand.
    await update($, bandAtom, () => false)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A /cd or the host moving the session: follow it to its project.
  if (features.backlog) on('classic.CwdChanged', async ($, e, next) => {
    context.cwd = e.new_cwd
    await setProject($, await projectOf($, e.new_cwd))

    return next(e)
  }).catch(($, e, next) => next(e))

  // The footer: two native Buttons, "<n> Tasks ↗" and "<n> Next Up ↗".
  // Desktop forces mod buttons there to its own look and one line
  // (anthropics/claude-code#100116).
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const tasks = features.tasks ? tasksLabel((await read($, sessionAtom)) ?? []) : null
    const backlog = features.backlog ? footerLabel((await read($, tasksAtom)) ?? [], (await read($, projectAtom)) ?? null) : null

    return (
      <Box key="next-up-footer" flexDirection="row" alignItems="center" gap={1}>
        {tasks ? <Button key="next-up-tasks-open" label={tasks} hover={{ color: AMBER }} onPress={() => press($, togglePane($, TASKS_PANE, 'Tasks'))} /> : null}
        {backlog ? <Button key="next-up-open" label={backlog} hover={{ color: AMBER }} onPress={() => press($, togglePane($))} /> : null}
      </Box>
    )
  })

  // The Tasks pane: To Do and Done, over the same cards.
  if (features.tasks) on('ui.render', { component: 'Pane', requestId: TASKS_PANE }, async ($, e) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>Tasks needs the terminal or the desktop app.</Text>
    }
    const els = $.ui.resolve(e) as Elements['desktop']
    const { Box, Button, Text } = els
    const tab = (await read($, tasksTabAtom)) ?? 'todo'
    const view = tasksView((await read($, sessionAtom)) ?? [], tab)
    const empty = tab === 'todo' ? 'Nothing to do. Claude lists the steps here when work takes more than one.' : 'Nothing done yet.'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {view.tabs.map(t => (
            <Button key={`tasks-tab-${t.id}`} label={t.label} variant={t.id === tab ? 'primary' : undefined} dimColor={t.id !== tab} onPress={() => press($, update($, tasksTabAtom, () => t.id))} />
          ))}
        </Box>
        {view.items.length === 0 ? <Text dimColor>{empty}</Text> : null}
        <Box flexDirection="column">{view.items.map(t => sessionCard($, els, t, e.props.bodyColumns))}</Box>
      </Box>
    )
  })

  // The session-start list: new sessions only, gone after the first prompt.
  if (features.backlog) on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, bandAtom))) return next(e)
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    const els = $.ui.resolve(e) as Elements['desktop']
    const { Box, Button, Text } = els
    const project = (await read($, projectAtom)) ?? null
    const top = bandTasks((await read($, tasksAtom)) ?? [], project)
    if (top.length === 0) return next(e)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text dimColor>Next Up</Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="band-see-all" label="See all ↗" dimColor onPress={() => press($, togglePane($))} />
            <Button key="band-hide" label="Hide" role="dismiss" onPress={() => press($, update($, bandAtom, () => false))} />
          </Box>
        </Box>
        <Box flexDirection="column">
          {top.map(task => backlogCard($, els, task, 'band', project === null, e.props.bodyColumns))}
        </Box>
      </Box>
    )
  })

  // The pane: ★, the project and All, over the same cards.
  if (features.backlog) on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>Next Up needs the terminal or the desktop app.</Text>
    }
    const els = $.ui.resolve(e) as Elements['desktop']
    const { Box, Button, Text } = els
    const view = paneView((await read($, tasksAtom)) ?? [], (await read($, projectAtom)) ?? null, (await read($, tabAtom)) ?? 'project')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {view.tabs.map(tab => (
            <Button key={`tab-${tab.id}`} label={tab.label} variant={tab.id === view.current ? 'primary' : undefined} dimColor={tab.id !== view.current} onPress={() => press($, update($, tabAtom, () => tab.id))} />
          ))}
        </Box>
        {view.items.length === 0 ? <Text dimColor>Nothing here yet. Claude adds tasks as it suggests them.</Text> : null}
        <Box flexDirection="column">
          {view.items.map(item =>
            item.kind === 'header' ? (
              // A group header outside the cards: the project, then a rule to the edge.
              <Box key={`group-${item.key}`} flexDirection="row" alignItems="center" gap={1} marginTop={1}>
                <Text dimColor>{item.name}</Text>
                {/* A bar a sixteenth of a line tall (~1px): an Svg line drew nothing, text rules wrapped. */}
                <Box flexGrow={1} minWidth={0} height={0.06} backgroundColor={RULE} />
              </Box>
            ) : (
              backlogCard($, els, item.task, 'pane', false, e.props.bodyColumns)
            ),
          )}
        </Box>
      </Box>
    )
  })

  // Claude's suggestion chips: keep a copy, and let the chip show as usual.
  if (features.backlog) on('tool.call', { tool: /spawn_task$/ }, async ($, e, next) => {
    const task = taskFromChip(e as unknown as Record<string, unknown>, context.project, stamp())
    if (task) await addIncoming($, [task])

    return next(e)
  }).catch(($, e, next) => next(e))

  if (features.backlog) on('tool.call', { tool: /^mcp__next-up__add_tasks$/ }, async ($, e) => {
    const incoming = tasksFromAddInput(e as unknown as AddInput, context.project, stamp())
    if (incoming.length === 0) return { result: 'No tasks added: each task needs a title.' }
    const { added, merged } = await addIncoming($, incoming)
    const where = context.project?.name ?? 'no project'
    const parts = [`Added ${plural(added.length, 'task')} to Next Up (${where})`]
    if (merged > 0) parts.push(`${plural(merged, 'task')} matched existing ${merged === 1 ? 'one and was' : 'ones and were'} merged`)

    return { result: `${parts.join('; ')}.` }
  }).catch(() => ({ result: 'Next Up could not save the tasks. Nothing was added.' }))

  if (features.backlog) on('tool.call', { tool: /^mcp__next-up__list_tasks$/ }, async ($, e) => {
    const scope = (e as unknown as { scope?: string }).scope === 'all' ? 'all' : 'project'

    return { result: listText(await refresh($), context.project, scope) }
  }).catch(() => ({ result: 'Next Up could not read the backlog.' }))

  if (features.backlog) on('tool.call', { tool: /^mcp__next-up__update_task$/ }, async ($, e) => {
    const input = e as unknown as { id?: string; status?: Task['status']; favourite?: boolean }
    const task = (await refresh($)).find(t => t.id === input.id)
    if (!task) return { result: `No Next Up task with id ${String(input.id)}.` }
    const fields: Extract<TaskEvent, { op: 'set' }>['fields'] = {}
    if (input.status) fields.status = input.status
    if (typeof input.favourite === 'boolean') fields.favourite = input.favourite
    if (Object.keys(fields).length === 0) return { result: 'Nothing to update: pass a status or favourite.' }
    await setFields($, task.id, fields)

    return { result: `Updated "${task.title}".` }
  }).catch(() => ({ result: 'Next Up could not update the task.' }))

  // The two tools Claude reaches for unprompted sit in its tool list, not
  // behind tool search: a deferred tool is a bare name until it is loaded,
  // and on desktop Claude did not go looking for it.
  on('tool.describe', { tool: /^mcp__next-up__(add_tasks|update_session_tasks)$/ }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: false }
  }).catch(($, e, next) => next(e))

  // Claude's changes to the session list. It sees the whole list in the result,
  // so the user's earlier edits are known to it from here on.
  if (features.tasks) on('tool.call', { tool: /^mcp__next-up__update_session_tasks$/ }, async ($, e) => {
    const { tasks, unknown } = await changeSession($, e as unknown as SessionChanges)
    edits.done = []
    edits.removed = []
    const note = unknown.length ? `\n(No task with id ${unknown.join(', ')}: it may have been removed.)` : ''

    return { result: `${sessionText(tasks)}${note}` }
  }).catch(() => ({ result: 'Next Up could not update the session task list.' }))

  // In the terminal Claude Code nudges Claude toward its own task tools; with
  // Next Up's list in use, that would make two lists.
  if (features.tasks) on('prompt.attachment', async ($, e, next) => {
    if (e.type === 'todo_reminder' || e.type === 'task_reminder') return { text: null }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The nudge, appended after the engine's own sections.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // Already given beside the first prompt: not twice.
    if (nudge.sent) return composed
    const text = nudgeText(e.tools)
    if (!text) return composed
    nudge.composed = true

    return { sections: [...composed.sections, { id: 'next-up', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // The first prompt takes the session-start list down. Sending a task's
  // prompt (from Now, or a New session's pre-filled box) marks it done;
  // filling the box alone does not.
  on('prompt.submit', async ($, e, next) => {
    // Only a prompt the user sent can start a task (not a peer's message, a
    // notification or a plugin's own prompt).
    const fromUser = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge' || e.origin?.kind === 'sdk'
    if (features.backlog && fromUser) {
      if (await read($, bandAtom)) await update($, bandAtom, () => false)
      const sent = submittedTask(e.text, await refresh($), context.project)
      if (sent) {
        await setFields($, sent.id, { status: 'done' })
        $.ui.toast(`Next Up: "${sent.title}" started`)
      }
    }
    // Unseen by the user, beside this prompt: Next Up's guidance, if the system
    // prompt never carried it, and their edits in the Tasks pane.
    // Both are marked delivered only once the prompt has gone through.
    const extra: string[] = []
    const sendsNudge = !nudge.composed && !nudge.sent
    if (sendsNudge) extra.push(`From the Next Up mod the user has installed:\n\n${nudgeText()}`)
    const pending = { done: [...edits.done], removed: [...edits.removed] }
    if (features.tasks) {
      const session = (await read($, sessionAtom)) ?? []
      const note = editsNote(session, pending)
      const reminder = note ? null : openReminder(session)
      if (note ?? reminder) extra.push((note ?? reminder) as string)
    }
    if (extra.length === 0) return next(e)
    const entered = await next({ ...e, context: [...(e.context ?? []), ...extra] })
    if (!entered.drop) {
      if (sendsNudge) nudge.sent = true
      edits.done = edits.done.filter(t => !pending.done.includes(t))
      edits.removed = edits.removed.filter(t => !pending.removed.includes(t))
    }

    return entered
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'next' }, async ($, e) => {
    const args = e.args.trim()
    if (!features.backlog || (args === 'tasks' && features.tasks)) {
      await togglePane($, TASKS_PANE, 'Tasks')
      return { text: 'Tasks pane toggled.' }
    }
    if (args === 'tasks') return { text: 'Tasks is switched off in /config (Next Up: Session tasks).' }
    if (/^plan(\s|$)/.test(args)) {
      const goal = args.slice(4).trim()
      if (!goal) return { text: 'Usage: /next plan <goal>' }
      await $.prompt.submit({ text: planPrompt(goal), asUser: true })
      return { text: `Planning "${goal}" into Next Up.` }
    }
    if (args === 'list' || args === 'all') return { text: listText(await refresh($), context.project, args === 'all' ? 'all' : 'project') }
    // Shows the session-start list in this session, which normally appears only
    // in a new one.
    if (args === 'band') {
      await update($, bandAtom, () => true)
      return { text: 'Next Up list shown above the prompt.' }
    }
    if (args) return { text: `Usage: /next [${features.tasks ? 'tasks | ' : ''}list | all | band | plan <goal>]` }
    await togglePane($)

    return { text: 'Next Up pane toggled.' }
  })
}
