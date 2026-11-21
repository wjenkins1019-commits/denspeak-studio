/**
 * Mic status light, used everywhere a voice can be recorded. The app's
 * convention: red when the mic is idle, green while a recording is running.
 */
export function RecordDot({ active }: { active: boolean }) {
  return (
    <span
      className={active ? 'record-dot live' : 'record-dot'}
      role="status"
      aria-label={active ? 'Recording in progress' : 'Not recording'}
      title={active ? 'Recording in progress' : 'Not recording'}
    />
  );
}
