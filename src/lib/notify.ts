// Render-finished toasts. Best-effort by design: anything missing, denied or
// throwing means no toast, never a failed render. A single Settings toggle
// (on by default) silences them; only an explicit false disables.
import { SETTING_KEYS } from './settings';

export interface NotifyStore {
  getItem(key: string): string | null;
}

function defaultStore(): NotifyStore | null {
  try {
    return (globalThis as { localStorage?: NotifyStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Only an explicit false disables; missing or corrupt means on. */
export function notificationsEnabled(store?: NotifyStore | null): boolean {
  const active = store ?? defaultStore();
  if (!active) return true;
  try {
    const raw = active.getItem(SETTING_KEYS.notifyRenders);
    if (raw === null) return true;
    return JSON.parse(raw) !== false;
  } catch {
    return true;
  }
}

export function notifyRenderFinished(
  input: {
    takeName: string;
    ok: boolean;
    error?: string;
  },
  store?: NotifyStore | null,
): void {
  try {
    if (!notificationsEnabled(store)) return;
    const Factory = (
      globalThis as unknown as {
        Notification?: new (title: string, options?: { body?: string }) => {
          close: () => void;
          onclick: ((event: Event) => void) | null;
        };
      }
    ).Notification;
    if (typeof Factory === 'undefined') return;
    const permission = (
      Factory as unknown as { permission?: string }
    ).permission;
    if (permission === 'denied') return;
    const note = new Factory(input.ok ? 'Render ready' : 'Render failed', {
      body: input.ok ? input.takeName : `${input.takeName} — ${input.error ?? 'render failed.'}`,
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // A toast must never break or block a render.
  }
}
