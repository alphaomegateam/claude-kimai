/** A Kimai timesheet entry, flattened to what the panel and chip draw. */
export type Entry = {
  id: number
  /** As Kimai sends it: local wall time with an offset, `2026-10-31T15:15:43-0500`. */
  begin: string
  /** Null while the timer runs. */
  end: string | null
  /** Seconds; 0 while running. */
  duration: number
  description: string
  projectId: number
  projectName: string
  customerId: number
  customerName: string
  activityId: number
  activityName: string
}

export type Filter = 'active' | 'completed' | 'all'

/** The running timers, polled for the footer chip. */
export type Running = { entries: Entry[]; error: string | null; at: number }

/** What the panel's list shows. */
export type Listing = {
  filter: Filter
  entries: Entry[]
  size: number
  error: string | null
  isLoading: boolean
}

export type Project = { id: number; name: string; customerId: number; customerName: string }
export type Activity = { id: number; name: string }

/** Projects, and activities by project id, loaded once per session. */
export type Catalog = {
  projects: Project[]
  activities: Record<string, Activity[]>
  error: string | null
}

export type View = { kind: 'list' } | { kind: 'edit'; id: number } | { kind: 'new' }

/** The edit or new form's fields, as typed. Times are `YYYY-MM-DD HH:MM`. */
export type Draft = {
  id: number | null
  isRunning: boolean
  begin: string
  end: string
  projectId: string
  activityId: string
  description: string
  /** The times as loaded, so an unchanged one is not sent back without its seconds. */
  beginWas: string
  endWas: string
  isConfirmingDelete: boolean
}

export type Notice = { text: string; tone: 'error' | 'success' } | null

declare module 'claude-code' {
  interface PluginState {
    kimai: {
      running: Shaped<Running>
      listing: Shaped<Listing>
      catalog: Shaped<Catalog>
      view: Shaped<View>
      draft: Shaped<Draft>
      notice: Shaped<Notice>
    }
  }
}
