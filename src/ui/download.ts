/**
 * Save JSON locally from the extension page with a user-triggered anchor
 * download. Requires no `downloads` permission (verified by e2e test).
 */
export function downloadJson(filename: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
