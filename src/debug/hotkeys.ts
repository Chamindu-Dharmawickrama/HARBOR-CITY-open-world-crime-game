export type HotkeyHandlers = Readonly<Record<string, () => void>>;

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * Developer hotkeys (F3 overlay, F4 physics lines, …). These are fixed, not rebindable, and
 * suppress the browser default (F3 would otherwise open find-in-page). Returns a remover.
 */
export function installDebugHotkeys(handlers: HotkeyHandlers, win: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const handler = handlers[event.code];
    if (!handler) return;
    event.preventDefault();
    handler();
  };
  win.addEventListener('keydown', onKeyDown);
  return () => win.removeEventListener('keydown', onKeyDown);
}
