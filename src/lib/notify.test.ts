// Render-finished notifications: best-effort toasts naming the take.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationsEnabled, notifyRenderFinished } from './notify';

interface Seen {
  title: string;
  body: string;
}

const seen: Seen[] = [];
let permission: NotificationPermission = 'granted';

function stubNotification(): void {
  seen.length = 0;
  permission = 'granted';
  vi.stubGlobal(
    'Notification',
    class {
      static get permission(): NotificationPermission {
        return permission;
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        seen.push({ title, body: options?.body ?? '' });
      }
      close(): void {}
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notificationsEnabled', () => {
  it('is on when unset, on, or corrupt — off only on explicit false', () => {
    expect(notificationsEnabled(null)).toBe(true);
    const store = (value: string | null) => (value === null ? null : ({ getItem: () => value } as const));
    expect(notificationsEnabled(store(null))).toBe(true);
    expect(notificationsEnabled(store('true'))).toBe(true);
    expect(notificationsEnabled(store('false'))).toBe(false);
    expect(notificationsEnabled(store('garbage{{{'))).toBe(true);
  });
});

describe('notifyRenderFinished', () => {
  it('names the take on success', () => {
    stubNotification();
    notifyRenderFinished({ takeName: 'Chapter 1', ok: true });
    expect(seen).toEqual([{ title: 'Render ready', body: 'Chapter 1' }]);
  });

  it('names the take and the error on failure', () => {
    stubNotification();
    notifyRenderFinished({ takeName: 'Chapter 2', ok: false, error: 'Engine gone.' });
    expect(seen).toEqual([{ title: 'Render failed', body: 'Chapter 2 — Engine gone.' }]);
  });

  it('stays silent when the toggle is off', () => {
    stubNotification();
    notifyRenderFinished(
      { takeName: 'Chapter 5', ok: true },
      { getItem: () => 'false' },
    );
    expect(seen).toEqual([]);
  });

  it('stays silent when denied or unavailable', () => {
    stubNotification();
    permission = 'denied';
    notifyRenderFinished({ takeName: 'Chapter 3', ok: true });
    vi.unstubAllGlobals();
    notifyRenderFinished({ takeName: 'Chapter 4', ok: true });
    expect(seen).toEqual([]);
  });
});
