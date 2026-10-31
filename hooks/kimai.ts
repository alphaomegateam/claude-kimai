import type { PluginOptions } from 'claude-code'

import type { Entry, Project } from '../types'

export type Settings = {
  baseUrl: string
  apiToken: string
  headersHelper: string
  helperTtlMs: number
  pollMs: number
}

export function settingsFrom(options: PluginOptions): Settings {
  const text = (key: string) => {
    const value = options[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const num = (key: string, fallback: number, min: number) => {
    const raw = options[key]
    const value = Number(raw)
    return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= min ? value : fallback
  }
  return {
    // Accept the server root or its /api path.
    baseUrl: text('url').replace(/\/+$/, '').replace(/\/api$/, ''),
    apiToken: text('apiToken'),
    headersHelper: text('headersHelper'),
    helperTtlMs: num('helperTtlMinutes', 15, 0) * 60_000,
    pollMs: num('pollSeconds', 60, 15) * 1000,
  }
}

export function configProblem(s: Settings): string | null {
  if (!s.baseUrl) return 'Set the Kimai URL in the plugin settings (url).'
  if (!/^https?:\/\//.test(s.baseUrl)) return 'The Kimai URL must start with http:// or https://.'
  if (!s.apiToken && !s.headersHelper) return 'Set apiToken or headersHelper in the plugin settings.'
  return null
}

/** Reads a helper's output: a JSON object of headers, or a bare token. */
export function headersFromHelper(stdout: string): Record<string, string> {
  const out = stdout.trim()
  if (out.startsWith('{')) {
    // A parse error quotes its input, which holds the secret: say it plainly.
    let parsed: unknown
    try {
      parsed = JSON.parse(out)
    } catch {
      throw new Error('The headers helper printed invalid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The headers helper must print a token or a JSON object of headers.')
    }
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
  }
  if (!out) throw new Error('The headers helper printed nothing.')
  return { Authorization: `Bearer ${out}` }
}

/** Kimai's validation errors, flattened into one line. */
export function kimaiError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { message?: string; errors?: unknown }
    const fields: string[] = []
    const walk = (node: unknown, name: string) => {
      if (!node || typeof node !== 'object') return
      const { errors, children } = node as { errors?: unknown; children?: Record<string, unknown> }
      if (Array.isArray(errors)) fields.push(...errors.map(err => (name ? `${name}: ${err}` : String(err))))
      if (children) for (const [key, child] of Object.entries(children)) walk(child, key)
    }
    walk(body.errors, '')
    const head = body.message ?? `HTTP ${status}`
    return fields.length ? `${head} (${fields.join('; ')})` : head
  } catch {
    return `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ''}`
  }
}

export type RawProject = { id: number; name: string; customer: number; parentTitle?: string }

export type RawTimesheet = {
  id: number
  begin: string
  end: string | null
  duration: number | null
  description: string | null
  activity: { id: number; name: string } | number
  project: { id: number; name: string; customer: { id: number; name: string } | number } | number
}

export function toProject(p: RawProject): Project {
  return { id: p.id, name: p.name, customerId: p.customer, customerName: p.parentTitle ?? '' }
}

export function toEntry(t: RawTimesheet): Entry {
  const project = typeof t.project === 'object' ? t.project : null
  const customer = project && typeof project.customer === 'object' ? project.customer : null
  const activity = typeof t.activity === 'object' ? t.activity : null
  return {
    id: t.id,
    begin: t.begin,
    end: t.end,
    duration: t.duration ?? 0,
    description: t.description ?? '',
    projectId: project?.id ?? (t.project as number),
    projectName: project?.name ?? '',
    customerId: customer?.id ?? 0,
    customerName: customer?.name ?? '',
    activityId: activity?.id ?? (t.activity as number),
    activityName: activity?.name ?? '',
  }
}

// Times. Kimai sends local wall time with an offset and takes local wall time
// without one, both in the user's Kimai time zone, so the form edits the wall
// time as written and never converts zones.

const WALL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/

/** `2026-10-31T15:15:43-0500` → `2026-10-31 15:15`. */
export function wall(kimai: string | null): string {
  const m = kimai ? WALL.exec(kimai) : null
  return m ? `${m[1]} ${m[2]}:${m[3]}` : ''
}

/** Milliseconds since the epoch of a Kimai timestamp. */
export function epoch(kimai: string): number {
  return Date.parse(kimai.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
}

/**
 * A typed time to what Kimai takes, `YYYY-MM-DDTHH:MM:SS`; a bare `HH:MM`
 * takes `day`'s date. Null when it does not parse.
 */
export function toKimai(typed: string, day: string): string | null {
  const text = typed.trim()
  const full = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  const bare = /^(\d{1,2}):(\d{2})$/.exec(text)
  const parts = full
    ? { date: full[1], h: full[2], m: full[3], sec: full[4] ?? '00' }
    : bare && /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? { date: day, h: bare[1], m: bare[2], sec: '00' }
      : null
  if (!parts?.date || !parts.h || !parts.m) return null
  const { date, h, m, sec } = parts
  if (Number(h) > 23 || Number(m) > 59 || Number(sec) > 59) return null
  return `${date}T${h.padStart(2, '0')}:${m}:${sec}`
}

/** `1h 05m`, `12m`, `0m`. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** How long an entry ran, or has run so far. */
export function elapsed(e: Entry, now: number): string {
  return e.end ? span(e.duration * 1000) : span(now - epoch(e.begin))
}
