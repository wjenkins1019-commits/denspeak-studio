// Small formatting helpers shared by the views.

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

export function formatDate(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Human disk size: B up to a kilobyte, then KB, MB, GB with one decimal. */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/** First few words of a script, used as the take name. */
export function titleFromScript(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ');
  const cleaned = words.replace(/[^\p{L}\p{N} '’()-]/gu, '').trim();
  if (!cleaned) return 'Untitled take';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
