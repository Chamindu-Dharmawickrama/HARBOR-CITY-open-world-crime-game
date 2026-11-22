import { RawInputState, type InputSource } from './raw-input';

/** Keys whose browser default (scrolling, focus change) must not fire while playing. */
const SUPPRESSED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Keyboard + mouse. Mouse motion counts as look input only while the pointer is locked. */
export class KeyboardMouseDevice implements InputSource {
  readonly id = 'keyboardMouse';
  readonly kind = 'keyboardMouse' as const;
  readonly raw = new RawInputState();
  private attached = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly win: Window = window,
  ) {}

  get pointerLocked(): boolean {
    return this.win.document.pointerLockElement === this.target;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.win.addEventListener('keydown', this.onKeyDown);
    this.win.addEventListener('keyup', this.onKeyUp);
    this.win.addEventListener('blur', this.onBlur);
    this.win.addEventListener('mousemove', this.onMouseMove);
    this.win.addEventListener('mouseup', this.onMouseUp);
    this.target.addEventListener('mousedown', this.onMouseDown);
    this.target.addEventListener('wheel', this.onWheel, { passive: true });
    this.target.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.win.removeEventListener('keydown', this.onKeyDown);
    this.win.removeEventListener('keyup', this.onKeyUp);
    this.win.removeEventListener('blur', this.onBlur);
    this.win.removeEventListener('mousemove', this.onMouseMove);
    this.win.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
  }

  requestPointerLock(): void {
    if (this.pointerLocked) return;
    try {
      const result = this.target.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Pointer lock can be refused (e.g. not triggered by a user gesture); look then stays idle.
    }
  }

  exitPointerLock(): void {
    if (this.pointerLocked) this.win.document.exitPointerLock();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    if (SUPPRESSED_KEYS.has(event.code)) event.preventDefault();
    this.raw.pressKey(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.raw.releaseKey(event.code);
  };

  private readonly onBlur = (): void => {
    this.raw.releaseAll();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.pointerLocked) this.raw.moveMouse(event.movementX, event.movementY);
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    this.raw.pressMouse(event.button);
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    this.raw.releaseMouse(event.button);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    this.raw.wheelDelta += event.deltaY;
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };
}
