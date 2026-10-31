import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, Draft, Entry, Filter, Listing, Notice, Running, View } from '../types'
import {
  configProblem,
  elapsed,
  headersFromHelper,
  kimaiError,
  settingsFrom,
  toEntry,
  toKimai,
  toProject,
  wall,
} from './kimai'
import type { RawProject, RawTimesheet, Settings } from './kimai'

const PANE = 'kimai'
const TITLE = 'Kimai'
const PAGE = 50

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const running = atom({ plugin: 'kimai', key: 'running' } as const, { entries: [], error: null, at: 0 } as Running, {
  shape: 'running-1',
})
const listing = atom(
  { plugin: 'kimai', key: 'listing' } as const,
  { filter: 'active', entries: [], size: PAGE, error: null, isLoading: false } as Listing,
  { shape: 'listing-1' },
)
const catalog = atom({ plugin: 'kimai', key: 'catalog' } as const, { projects: [], activities: {}, error: null } as Catalog, {
  shape: 'catalog-1',
})
const view = atom({ plugin: 'kimai', key: 'view' } as const, { kind: 'list' } as View, { shape: 'view-1' })
const EMPTY_DRAFT: Draft = {
  id: null,
  isRunning: false,
  begin: '',
  end: '',
  projectId: '',
  activityId: '',
  description: '',
  beginWas: '',
  endWas: '',
  isConfirmingDelete: false,
}
const draft = atom({ plugin: 'kimai', key: 'draft' } as const, EMPTY_DRAFT, { shape: 'draft-2' })
const notice = atom({ plugin: 'kimai', key: 'notice' } as const, null as Notice, { shape: 'notice-1' })

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Set by register: a reload with new options runs it again.
let settings: Settings = settingsFrom({})
let problem: string | null = configProblem(settings)
let cachedAuth: { headers: Record<string, string>; until: number } | null = null
// One helper run shared by every request that needs it while it runs.
let pendingAuth: Promise<Record<string, string>> | null = null

async function runHelper($: EngineInterface): Promise<Record<string, string>> {
  const now = await $.clock.now()
  const run = await $.process.run(['/bin/sh', '-c', settings.headersHelper], { timeoutMs: 60_000 })
  if (run.exitCode !== 0) {
    throw new Error(`Headers helper failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 200)}`)
  }
  const headers = headersFromHelper(run.stdout)
  cachedAuth = { headers, until: now + settings.helperTtlMs }
  return headers
}

async function authHeaders($: EngineInterface): Promise<Record<string, string>> {
  if (settings.apiToken) return { Authorization: `Bearer ${settings.apiToken}` }
  if (cachedAuth && cachedAuth.until > (await $.clock.now())) return cachedAuth.headers
  pendingAuth ??= runHelper($).finally(() => {
    pendingAuth = null
  })
  return pendingAuth
}

async function request<T>($: EngineInterface, method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const auth = await authHeaders($)
    const res = await $.http.fetch(`${settings.baseUrl}/api${path}`, {
      method,
      headers: {
        ...auth,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    // A rotated token: run the helper again once.
    if (res.status === 401 && attempt === 0 && !settings.apiToken) {
      // Requests that failed together share one new helper run.
      if (cachedAuth?.headers === auth) cachedAuth = null
      continue
    }
    if (!res.ok) throw new Error(kimaiError(res.status, res.text))
    return (res.text ? JSON.parse(res.text) : null) as T
  }
}

async function fetchEntries($: EngineInterface, filter: Filter, size: number): Promise<Entry[]> {
  const path =
    filter === 'active'
      ? '/timesheets/active'
      : `/timesheets?full=true&size=${size}&orderBy=begin&order=DESC${filter === 'completed' ? '&active=0' : ''}`
  return (await request<RawTimesheet[]>($, 'GET', path)).map(toEntry)
}

async function refreshRunning($: EngineInterface) {
  if (problem) return
  const at = await $.clock.now()
  try {
    const entries = await fetchEntries($, 'active', PAGE)
    await update($, running, () => ({ entries, error: null, at }))
  } catch (err) {
    await update($, running, prev => ({ ...prev, error: message(err), at }))
  }
}

async function refreshListing($: EngineInterface) {
  if (problem) return
  const { filter, size } = await read($, listing)
  await update($, listing, prev => ({ ...prev, isLoading: true }))
  try {
    const entries = await fetchEntries($, filter, size)
    // A filter switched while this loaded: leave the newer load's result.
    await update($, listing, prev => (prev.filter === filter ? { ...prev, entries, error: null, isLoading: false } : prev))
  } catch (err) {
    await update($, listing, prev => (prev.filter === filter ? { ...prev, error: message(err), isLoading: false } : prev))
  }
}

async function refreshAll($: EngineInterface) {
  await Promise.all([refreshRunning($), refreshListing($)])
}

async function say($: EngineInterface, text: string, tone: 'error' | 'success') {
  await update($, notice, () => ({ text, tone }))
}

async function loadProjects($: EngineInterface) {
  if ((await read($, catalog)).projects.length) return
  try {
    const raw = await request<RawProject[]>($, 'GET', '/projects?visible=1')
    const projects = raw
      .map(toProject)
      .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.name.localeCompare(b.name))
    await update($, catalog, prev => ({ ...prev, projects, error: null }))
  } catch (err) {
    await update($, catalog, prev => ({ ...prev, error: message(err) }))
  }
}

async function loadActivities($: EngineInterface, projectId: string) {
  // A failed load stores nothing, so picking the project again retries it.
  if (!projectId || (await read($, catalog)).activities[projectId] !== undefined) return
  await update($, catalog, prev => ({ ...prev, error: null }))
  try {
    const raw = await request<{ id: number; name: string }[]>($, 'GET', `/activities?project=${projectId}&visible=1`)
    const list = raw.map(a => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name))
    await update($, catalog, prev => ({ ...prev, activities: { ...prev.activities, [projectId]: list } }))
  } catch (err) {
    await update($, catalog, prev => ({ ...prev, error: message(err) }))
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE, columns: 64 })
}

async function togglePane($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isOpen) return $.ui.close({ id: PANE })
  await openPane($)
  void refreshListing($)
}

async function showList($: EngineInterface) {
  await update($, view, (): View => ({ kind: 'list' }))
}

async function setFilter($: EngineInterface, filter: Filter) {
  await update($, listing, prev => ({ ...prev, filter, size: PAGE, entries: prev.filter === filter ? prev.entries : [] }))
  await showList($)
  await refreshListing($)
}

async function editEntry($: EngineInterface, e: Entry) {
  await update($, draft, () => ({
    ...EMPTY_DRAFT,
    id: e.id,
    isRunning: e.end === null,
    begin: wall(e.begin),
    end: wall(e.end),
    beginWas: wall(e.begin),
    endWas: wall(e.end),
    projectId: String(e.projectId),
    activityId: String(e.activityId),
    description: e.description,
  }))
  await update($, notice, () => null)
  await update($, view, (): View => ({ kind: 'edit', id: e.id }))
  await loadProjects($)
  await loadActivities($, String(e.projectId))
}

async function latestEntry($: EngineInterface): Promise<Entry | undefined> {
  const known = async () => (await read($, running)).entries[0] ?? (await read($, listing)).entries[0]
  try {
    const [latest] = await fetchEntries($, 'all', 1)
    return latest ?? (await known())
  } catch {
    return known()
  }
}

async function newTimer($: EngineInterface) {
  await update($, draft, () => ({ ...EMPTY_DRAFT, isRunning: true }))
  await update($, notice, () => null)
  await update($, view, (): View => ({ kind: 'new' }))
  // Start from the latest entry's project and activity: the usual next timer.
  const latest = await latestEntry($)
  await update($, draft, prev => ({
    ...prev,
    projectId: prev.projectId || (latest ? String(latest.projectId) : ''),
    activityId: prev.projectId ? prev.activityId : latest ? String(latest.activityId) : '',
  }))
  await loadProjects($)
  if (latest) await loadActivities($, String(latest.projectId))
}

async function act($: EngineInterface, work: () => Promise<unknown>, done: string) {
  try {
    await work()
    await say($, done, 'success')
    await showList($)
  } catch (err) {
    await say($, message(err), 'error')
  }
  await refreshAll($)
}

async function stopEntry($: EngineInterface, e: Entry) {
  const now = await $.clock.now()
  await act($, () => request($, 'PATCH', `/timesheets/${e.id}/stop`), `Stopped ${e.customerName || 'timer'} after ${elapsed(e, now)}.`)
}

async function save($: EngineInterface) {
  const d = await read($, draft)
  const fail = (text: string) => say($, text, 'error')
  if (!d.projectId) return fail('Pick a project.')
  if (!d.activityId) return fail('Pick an activity.')
  const form: Record<string, unknown> = {
    project: Number(d.projectId),
    activity: Number(d.activityId),
    description: d.description,
  }
  // An unchanged time is left out, so Kimai keeps its seconds.
  const begin = d.begin.trim()
  if (begin) {
    const value = toKimai(begin, '')
    if (!value) return fail('Start must be YYYY-MM-DD HH:MM.')
    if (begin !== d.beginWas) form.begin = value
  } else if (d.id !== null) {
    return fail('Start is required.')
  }
  const end = d.end.trim()
  if (end) {
    const value = toKimai(end, begin.slice(0, 10))
    if (!value) return fail('End must be YYYY-MM-DD HH:MM, or HH:MM on the start date.')
    if (end !== d.endWas) form.end = value
  } else if (d.id !== null && !d.isRunning) {
    return fail('End is required for a completed entry.')
  }
  if (d.id === null) {
    await act($, () => request($, 'POST', '/timesheets', form), 'Timer started.')
  } else {
    const id = d.id
    await act($, () => request($, 'PATCH', `/timesheets/${id}`, form), 'Saved.')
  }
}

// A chip press has no pane to show its notice in: echo it as a toast.
async function notify($: EngineInterface) {
  const n = await read($, notice)
  if (!n) return
  $.ui.toast(n.text)
  await update($, notice, () => null)
}

export const register: Register = (on, options) => {
  settings = settingsFrom(options)
  problem = configProblem(settings)
  cachedAuth = null
  pendingAuth = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kimai',
      description: 'Kimai timers: list, edit and start them in a side panel',
      argumentHint: '[new]',
    })
    if (!problem) {
      void refreshRunning($)
      $.clock.every(settings.pollMs, () => refreshRunning($))
    }
    return next(e)
  })

  on('command.run', { command: 'kimai' }, async ($, e) => {
    await openPane($)
    if (problem) return { text: `Kimai is not set up: ${problem}` }
    if (e.args.trim() === 'new') {
      await newTimer($)
    } else {
      void refreshListing($)
    }
    const count = (await read($, running)).entries.length
    return { text: `Kimai panel opened. ${count === 1 ? '1 timer' : `${count} timers`} running.` }
  })

  // The footer chip, after the engine's mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const state = await read($, running)
    const count = state.entries.length
    if (problem || (count === 0 && !state.error)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes.join(' & ')
    const now = await $.clock.now()
    const only = count === 1 ? state.entries[0] : null

    return (
      <Box>
        {modes && <Text dimColor>{modes} · </Text>}
        {state.error && count === 0 ? (
          <Button key="kimai-chip" onPress={() => togglePane($)}>
            <Text color="warning">kimai: error</Text>
          </Button>
        ) : only ? (
          <Button key="kimai-chip" onPress={() => stopEntry($, only).then(() => notify($))}>
            <Text color="success">● </Text>
            <Text>{only.customerName || only.projectName}</Text>
            <Text dimColor> · {elapsed(only, now)}</Text>
          </Button>
        ) : (
          <Button key="kimai-chip" onPress={() => togglePane($)}>
            <Text color="success">● </Text>
            <Text>{count} timers running</Text>
          </Button>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    if (problem) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Kimai is not set up</Text>
          <Text wrap="wrap">{problem}</Text>
          <Text dimColor wrap="wrap">
            Set the plugin's options in /config, or under pluginConfigs.kimai.options in ~/.claude/settings.json.
          </Text>
        </Box>
      )
    }

    const list = await read($, listing)
    const current = await read($, view)
    const note = await read($, notice)
    const now = await $.clock.now()

    const tabs: [Filter, string, string][] = [
      ['active', 'Active', 'a'],
      ['completed', 'Completed', 'c'],
      ['all', 'All', 'l'],
    ]
    const header = (
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Box flexDirection="row" gap={1}>
          {tabs.map(([filter, label, hotkey]) => (
            <Button
              key={`filter-${filter}`}
              label={label}
              hotkey={hotkey}
              variant={current.kind === 'list' && list.filter === filter ? 'primary' : 'secondary'}
              dimColor={!(current.kind === 'list' && list.filter === filter)}
              onPress={() => setFilter($, filter)}
            />
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="new" label="New timer" hotkey="n" onPress={() => newTimer($)} />
          <Button key="refresh" label="Refresh" hotkey="r" dimColor onPress={() => refreshAll($)} />
        </Box>
      </Box>
    )
    const banner = note && (
      <Box borderStyle="round" borderColor={note.tone} paddingX={1} key="notice">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={note.tone} wrap="wrap">
            {note.text}
          </Text>
        </Box>
        <Button key="dismiss" label="×" plain dimColor onPress={() => update($, notice, () => null)} />
      </Box>
    )

    if (current.kind !== 'list' && e.surface === 'mobile') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor wrap="wrap">
            Editing needs text fields, which this surface does not draw. Use the desktop app or a terminal.
          </Text>
          <Button key="cancel" label="Back" onPress={() => showList($)} />
        </Box>
      )
    }

    if (current.kind !== 'list' && e.surface !== 'mobile') {
      const { Input, Select } = $.ui.resolve(e)
      const d = await read($, draft)
      const cat = await read($, catalog)
      const isNew = current.kind === 'new'
      const projectOptions = cat.projects.map(p => ({
        value: String(p.id),
        label: p.customerName ? `${p.customerName} › ${p.name}` : p.name,
      }))
      if (d.projectId && !projectOptions.some(o => o.value === d.projectId)) {
        projectOptions.unshift({ value: d.projectId, label: `Project #${d.projectId}` })
      }
      const activities = cat.activities[d.projectId] ?? []
      const activityOptions = activities.map(a => ({ value: String(a.id), label: a.name }))
      if (d.activityId && !activityOptions.some(o => o.value === d.activityId)) {
        activityOptions.unshift({ value: d.activityId, label: `Activity #${d.activityId}` })
      }
      const set = (patch: Partial<Draft>) => update($, draft, prev => ({ ...prev, ...patch, isConfirmingDelete: false }))
      const id = d.id

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {banner}
          <Text bold>{isNew ? 'Start a new timer' : `Edit entry #${id}${d.isRunning ? ' (running)' : ''}`}</Text>
          {cat.error && <Text color="error">{cat.error}</Text>}
          {projectOptions.length ? (
            <Select
              key="project"
              label="Project"
              options={projectOptions}
              value={d.projectId || undefined}
              onSelect={async value => {
                const list = (await read($, catalog)).activities[value]
                const keep = list?.some(a => String(a.id) === d.activityId)
                await set({ projectId: value, activityId: keep ? d.activityId : '' })
                await loadActivities($, value)
              }}
            />
          ) : (
            <Text dimColor>Loading projects…</Text>
          )}
          {activityOptions.length ? (
            <Select
              key="activity"
              label="Activity"
              options={activityOptions}
              value={d.activityId || undefined}
              onSelect={value => set({ activityId: value })}
            />
          ) : (
            <Text dimColor>
              {!d.projectId
                ? 'Pick a project first.'
                : cat.activities[d.projectId] !== undefined
                  ? 'This project has no activities.'
                  : cat.error
                    ? 'Could not load activities. Pick the project again to retry.'
                    : 'Loading activities…'}
            </Text>
          )}
          <Input
            key="description"
            label="Description"
            value={d.description}
            placeholder="What are you working on?"
            submitLabel={isNew ? 'start' : 'save'}
            onInput={value => set({ description: value })}
            onSubmit={value => set({ description: value }).then(() => save($))}
          />
          <Input
            key="begin"
            label="Start"
            value={d.begin}
            placeholder={isNew ? 'now (or YYYY-MM-DD HH:MM)' : 'YYYY-MM-DD HH:MM'}
            submitLabel={isNew ? 'start' : 'save'}
            onInput={value => set({ begin: value })}
            onSubmit={value => set({ begin: value }).then(() => save($))}
          />
          {!isNew && (
            <Input
              key="end"
              label="End"
              value={d.end}
              placeholder={d.isRunning ? 'running (or HH:MM to stop it then)' : 'YYYY-MM-DD HH:MM or HH:MM'}
              submitLabel="save"
              onInput={value => set({ end: value })}
              onSubmit={value => set({ end: value }).then(() => save($))}
            />
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="save" label={isNew ? 'Start timer' : 'Save'} variant="primary" onPress={() => save($)} />
            <Button key="cancel" label="Cancel" dimColor onPress={() => showList($)} />
            {id !== null && d.isRunning && (
              <Button
                key="stop"
                label="Stop now"
                onPress={async () => {
                  const e = (await read($, running)).entries.find(x => x.id === id)
                  await act($, () => request($, 'PATCH', `/timesheets/${id}/stop`), `Stopped${e ? ` ${e.customerName}` : ''}.`)
                }}
              />
            )}
            {id !== null &&
              (d.isConfirmingDelete ? (
                <Button
                  key="delete-confirm"
                  label="Really delete?"
                  onPress={() => act($, () => request($, 'DELETE', `/timesheets/${id}`), `Deleted entry #${id}.`)}
                />
              ) : (
                <Button
                  key="delete"
                  label="Delete"
                  dimColor
                  onPress={() => update($, draft, prev => ({ ...prev, isConfirmingDelete: true }))}
                />
              ))}
          </Box>
          <Text dimColor wrap="wrap">
            Times are in your Kimai time zone. HH:MM alone means the start date.
          </Text>
        </Box>
      )
    }

    const empty = {
      active: 'No timers running.',
      completed: 'No completed entries.',
      all: 'No entries yet.',
    }[list.filter]

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {banner}
        {list.error && (
          <Box borderStyle="round" borderColor="error" paddingX={1}>
            <Text color="error" wrap="wrap">
              {list.error}
            </Text>
          </Box>
        )}
        {list.isLoading && list.entries.length === 0 && <Text dimColor>Loading…</Text>}
        {!list.isLoading && !list.error && list.entries.length === 0 && (
          <Box paddingY={1} justifyContent="center">
            <Text dimColor>{empty}</Text>
          </Box>
        )}
        {list.entries.map(entry => {
          const isRunning = entry.end === null
          return (
            <Box
              key={`row-${entry.id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={isRunning ? 'success' : 'subtle'}
              borderDimColor={!isRunning}
              hover={{ borderDimColor: false }}
              paddingX={1}
            >
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                  <Text wrap="truncate-end">
                    {isRunning && <Text color="success">● </Text>}
                    <Text bold>{entry.customerName || '—'}</Text>
                    <Text dimColor> › {entry.projectName}</Text>
                  </Text>
                </Box>
                <Text color={isRunning ? 'success' : undefined}>{elapsed(entry, now)}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {entry.activityName}
                {entry.description ? ` · ${entry.description}` : ''}
              </Text>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Text dimColor wrap="truncate-end">
                  {wall(entry.begin)}
                  {entry.end ? ` → ${wall(entry.end).slice(wall(entry.begin).slice(0, 10) === wall(entry.end).slice(0, 10) ? 11 : 0)}` : ' → now'}
                </Text>
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  <Button key={`edit-${entry.id}`} label="Edit" dimColor onPress={() => editEntry($, entry)} />
                  {isRunning ? (
                    <Button key={`stop-${entry.id}`} label="Stop" onPress={() => stopEntry($, entry)} />
                  ) : (
                    <Button
                      key={`restart-${entry.id}`}
                      label="Restart"
                      dimColor
                      onPress={() => act($, () => request($, 'PATCH', `/timesheets/${entry.id}/restart`, { copy: 'all' }), `Restarted ${entry.customerName || 'timer'}.`)}
                    />
                  )}
                </Box>
              </Box>
            </Box>
          )
        })}
        {list.filter !== 'active' && list.entries.length >= list.size && (
          <Button
            key="more"
            label="Load more"
            dimColor
            onPress={async () => {
              await update($, listing, prev => ({ ...prev, size: prev.size + PAGE }))
              await refreshListing($)
            }}
          />
        )}
      </Box>
    )
  })
}
