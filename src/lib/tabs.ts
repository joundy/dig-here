/** The arrow keys a screen reader tells people to use on a `role="tablist"`. Put on the tablist's `onkeydown`. */
export function tabArrows(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = tabs[(at + step + tabs.length) % tabs.length];
  next.focus();
  next.click();
}
