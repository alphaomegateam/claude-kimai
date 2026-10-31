import { expect, test } from 'claude-code/testing'

import { elapsed, headersFromHelper, kimaiError, settingsFrom, toEntry, toKimai, wall } from '../hooks/kimai'

const OPTIONS = { url: 'https://kimai.example.com/', apiToken: 'tok-123' }
const HELPER = { url: 'https://kimai.example.com', headersHelper: 'op read x' }
// 2026-10-31 16:20 in America/Chicago (-0500).
const NOW = Date.parse('2026-10-31T16:20:43-05:00')

function timesheet(id: number, customer: string, begin: string, end: string | null = null) {
  return {
    id,
    begin,
    end,
    duration: end ? 3600 : 0,
    description: 'Work',
    activity: { id: 1, name: 'Development' },
    project: { id: 26, name: 'Website', customer: { id: 15, name: customer } },
  }
}

const RUNNING = timesheet(1866, 'Acme Corp', '2026-10-31T15:15:43-0500')
const DONE = timesheet(1865, 'Globex', '2026-10-30T11:03:00-0500', '2026-10-30T12:03:00-0500')

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown }
type Reply = { status: number; body: unknown }
type Kimai = {
  active?: unknown[]
  history?: unknown[]
  /** Answers a request before the defaults do; undefined falls through. */
  respond?: (call: Call, calls: Call[]) => Reply | undefined
}

type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type TestDollar = Parameters<TestBody>[0]
type TestOn = Parameters<TestBody>[1]

/** Stands for the engine and a Kimai server; returns the requests it saw. */
function engine(on: TestOn, kimai: Kimai = {}) {
  const calls: Call[] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  // A period that resolves at once would poll in a loop: refuse it, ending the interval.
  on('clock.every', () => ({ deny: 'no polling in tests' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    const call: Call = {
      method: e.init?.method ?? 'GET',
      path: e.url.replace('https://kimai.example.com/api', ''),
      headers: e.init?.headers ?? {},
      body: e.init?.body ? JSON.parse(e.init.body) : undefined,
    }
    calls.push(call)
    const reply = kimai.respond?.(call, calls) ?? {
      status: 200,
      body:
        call.method !== 'GET'
          ? {}
          : call.path === '/timesheets/active'
            ? (kimai.active ?? [])
            : call.path.startsWith('/timesheets?')
              ? (kimai.history ?? [])
              : call.path.startsWith('/projects')
                ? [{ id: 26, name: 'Website', customer: 15, parentTitle: 'Acme Corp' }]
                : call.path.startsWith('/activities')
                  ? [{ id: 1, name: 'Development' }]
                  : [],
    }
    const ok = reply.status >= 200 && reply.status < 300
    return { value: { status: reply.status, ok, headers: {}, text: JSON.stringify(reply.body) } }
  })
  return { calls, toasts }
}

const CHIP = { plugin: 'kimai', component: 'SessionMode', requestId: 'mode', props: { modes: [] } } as const
const PANE = {
  plugin: 'kimai',
  component: 'Pane',
  requestId: 'kimai',
  props: {
    title: 'Kimai',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const start = ($: TestDollar) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

/** The session's first poll runs unawaited; a press of Refresh settles one. */
async function refresh($: TestDollar) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.unmount()
}

const helperRun = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

test('times parse and print as Kimai wall time', () => {
  expect(wall('2026-10-31T15:15:43-0500')).toBe('2026-10-31 15:15')
  expect(wall(null)).toBe('')
  expect(toKimai('2026-10-31 9:05', '')).toBe('2026-10-31T09:05:00')
  expect(toKimai('17:30', '2026-10-31')).toBe('2026-10-31T17:30:00')
  expect(toKimai('17:30', '')).toBeNull()
  expect(toKimai('25:00', '2026-10-31')).toBeNull()
  expect(toKimai('yesterday', '2026-10-31')).toBeNull()
})

test('elapsed reads Kimai offsets', () => {
  const e = toEntry(RUNNING)
  expect(elapsed(e, NOW)).toBe('1h 05m')
  expect(elapsed({ ...e, end: 'x', duration: 720 }, NOW)).toBe('12m')
})

test('a timesheet without nested objects keeps its ids', () => {
  const e = toEntry({ id: 7, begin: 'b', end: null, duration: null, description: null, activity: 3, project: 9 })
  expect(e).toMatchObject({ id: 7, projectId: 9, activityId: 3, customerName: '', description: '', duration: 0 })
})

test('settings take 0 for the helper cache and hold the poll to 15s', () => {
  expect(settingsFrom({ helperTtlMinutes: 0 }).helperTtlMs).toBe(0)
  expect(settingsFrom({}).helperTtlMs).toBe(15 * 60_000)
  expect(settingsFrom({ pollSeconds: 5 }).pollMs).toBe(60_000)
  expect(settingsFrom({ url: 'https://k.example.com/api/' }).baseUrl).toBe('https://k.example.com')
})

test('helpers print a token or a header object', () => {
  expect(headersFromHelper('abc\n')).toEqual({ Authorization: 'Bearer abc' })
  expect(headersFromHelper('{"X-AUTH-USER":"me","X-AUTH-TOKEN":"t"}')).toEqual({
    'X-AUTH-USER': 'me',
    'X-AUTH-TOKEN': 't',
  })
  expect(kimaiError(400, '{"message":"Validation Failed","errors":{"children":{"end":{"errors":["End before start"]}}}}')).toBe(
    'Validation Failed (end: End before start)',
  )
})

test('invalid helper JSON never quotes what the helper printed', () => {
  let text = ''
  try {
    headersFromHelper('{"X-AUTH-TOKEN":s3cr3t-value}')
  } catch (err) {
    text = String(err)
  }
  expect(text).toContain('invalid JSON')
  expect(text).not.toContain('s3cr3t')
})

test('one running timer: the chip names the customer, and a press stops it', { options: OPTIONS }, async ($, on) => {
  const { calls, toasts } = engine(on, { active: [RUNNING] })
  await start($)
  await refresh($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...CHIP, surface })
    const chip = await ui.find({ key: 'kimai-chip' })
    expect(chip?.text).toContain('Acme Corp')
    expect(chip?.text).toContain('1h 05m')
    await ui.unmount()
  }

  expect(calls[0]?.headers.Authorization).toBe('Bearer tok-123')
  const ui = await $.ui.mount({ ...CHIP, surface: 'desktop' })
  await ui.press({ key: 'kimai-chip' })
  expect(calls.some(c => c.method === 'PATCH' && c.path === '/timesheets/1866/stop')).toBe(true)
  expect(toasts).toEqual(['Stopped Acme Corp after 1h 05m.'])
  await ui.unmount()

  // The toast was the notice: the pane does not show it again later.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /Stopped/ })).toBeUndefined()
  await pane.unmount()
})

test('several running timers: the chip counts them', { options: OPTIONS }, async ($, on) => {
  engine(on, { active: [RUNNING, timesheet(2, 'Globex', '2026-10-31T16:00:00-0500')] })
  await start($)
  await refresh($)
  const ui = await $.ui.mount({ ...CHIP, surface: 'terminal' })
  expect((await ui.find({ key: 'kimai-chip' }))?.text).toContain('2 timers running')
  await ui.unmount()
})

test('no running timer: the chip leaves the footer alone', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)
  const ui = await $.ui.mount({ ...CHIP, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the panel edits an entry and sends Kimai wall time', { options: OPTIONS }, async ($, on) => {
  const { calls } = engine(on, { active: [RUNNING] })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-active' })
  await ui.press({ key: 'edit-1866' })
  await ui.input({ key: 'begin', text: '2026-10-31 15:00', kind: 'change' })
  await ui.input({ key: 'description', text: 'Kickoff call', kind: 'change' })
  await ui.press({ key: 'save' })

  const patch = calls.find(c => c.method === 'PATCH' && c.path === '/timesheets/1866')
  expect(patch?.body).toEqual({ project: 26, activity: 1, description: 'Kickoff call', begin: '2026-10-31T15:00:00' })
  await ui.unmount()
})

test('saving untouched times leaves them out, so Kimai keeps the seconds', { options: OPTIONS }, async ($, on) => {
  const { calls } = engine(on, { history: [DONE] })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-completed' })
  await ui.press({ key: 'edit-1865' })
  await ui.input({ key: 'description', text: 'Notes', kind: 'change' })
  await ui.press({ key: 'save' })

  const patch = calls.find(c => c.method === 'PATCH' && c.path === '/timesheets/1865')
  expect(patch?.body).toEqual({ project: 26, activity: 1, description: 'Notes' })
  await ui.unmount()
})

test('a new timer starts from the latest entry, even with none running', { options: OPTIONS }, async ($, on) => {
  const { calls } = engine(on, { history: [DONE] })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'new' })
  await ui.input({ key: 'description', text: 'Kickoff', kind: 'change' })
  await ui.press({ key: 'save' })

  const post = calls.find(c => c.method === 'POST' && c.path === '/timesheets')
  expect(post?.body).toEqual({ project: 26, activity: 1, description: 'Kickoff' })
  await ui.unmount()
})

test('restart copies the entry, delete asks first', { options: OPTIONS }, async ($, on) => {
  const { calls } = engine(on, { history: [DONE] })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-completed' })
  await ui.press({ key: 'restart-1865' })
  expect(calls.find(c => c.path === '/timesheets/1865/restart')?.body).toEqual({ copy: 'all' })

  await ui.press({ key: 'edit-1865' })
  await ui.press({ key: 'delete' })
  expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  await ui.press({ key: 'delete-confirm' })
  expect(calls.some(c => c.method === 'DELETE' && c.path === '/timesheets/1865')).toBe(true)
  await ui.unmount()
})

test('load more asks for the next page', { options: OPTIONS }, async ($, on) => {
  const page = Array.from({ length: 50 }, (_, i) =>
    timesheet(i + 1, 'Acme Corp', '2026-10-30T09:00:00-0500', '2026-10-30T10:00:00-0500'),
  )
  const { calls } = engine(on, { history: page })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-all' })
  await ui.press({ key: 'more' })
  expect(calls.some(c => c.path.includes('size=100'))).toBe(true)
  await ui.unmount()
})

test('a Kimai error reaches the notice', { options: OPTIONS }, async ($, on) => {
  engine(on, {
    active: [RUNNING],
    respond: c =>
      c.method === 'PATCH'
        ? { status: 400, body: { message: 'Validation Failed', errors: { children: { end: { errors: ['End before start'] } } } } }
        : undefined,
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-active' })
  await ui.press({ key: 'stop-1866' })
  expect((await ui.find({ type: 'Text', text: /Validation/ }))?.text).toBe('Validation Failed (end: End before start)')
  await ui.unmount()
})

test('a headers helper supplies the token, run once for parallel requests', { options: HELPER }, async ($, on) => {
  const { calls } = engine(on)
  let runs = 0
  on('process.run', (_, e) => {
    expect(e.argv).toEqual(['/bin/sh', '-c', 'op read x'])
    runs += 1
    return helperRun('helper-token\n')
  })
  await start($)
  await refresh($)
  expect(calls.at(-1)?.headers.Authorization).toBe('Bearer helper-token')
  expect(runs).toBe(1)
})

test('a 401 runs the helper again once, then shows the error', { options: HELPER }, async ($, on) => {
  const { calls } = engine(on, {
    respond: c => (c.path.startsWith('/timesheets?') ? { status: 401, body: { message: 'Invalid credentials' } } : undefined),
  })
  let runs = 0
  on('process.run', () => {
    runs += 1
    return helperRun(`token-${runs}`)
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-completed' })
  expect(runs).toBe(2)
  expect(calls.map(c => c.headers.Authorization)).toContain('Bearer token-2')
  expect((await ui.find({ type: 'Text', text: /Invalid credentials/ }))?.text).toBe('Invalid credentials')
  await ui.unmount()
})

test('a failing helper shows its exit code', { options: HELPER }, async ($, on) => {
  engine(on)
  on('process.run', () => helperRun('', 1, '[ERROR] not signed in'))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'filter-completed' })
  expect((await ui.find({ type: 'Text', text: /Headers helper failed/ }))?.text).toBe(
    'Headers helper failed (exit 1): [ERROR] not signed in',
  )
  await ui.unmount()
})

test('without a URL the panel says how to set it up', { options: {} }, async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /not set up/ }))?.text).toBe('Kimai is not set up')
  await ui.unmount()
})
