/** Replaces the view with a readable error panel when the engine cannot continue. */
export function showFatalError(parent: HTMLElement, error: unknown): void {
  const panel = document.createElement('div');
  panel.className = 'hc-fatal';
  panel.setAttribute('role', 'alert');
  const heading = document.createElement('h2');
  heading.textContent = 'Harbor City stopped';
  const detail = document.createElement('pre');
  detail.textContent = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  const hint = document.createElement('p');
  hint.textContent =
    'Reload the page to try again. If this keeps happening, the details above help with a fix.';
  panel.append(heading, detail, hint);
  parent.appendChild(panel);
}
