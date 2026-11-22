export const MOUSE_BUTTON_COUNT = 5;
export const PAD_AXIS_COUNT = 8;
export const PAD_BUTTON_COUNT = 20;
/** Analog pad buttons (triggers) count as pressed above this value. */
export const PAD_BUTTON_THRESHOLD = 0.5;

/**
 * Raw state of one input device: which keys/buttons are held, how many presses happened since
 * the input system last consumed them, accumulated mouse motion, and gamepad axes.
 * Physical devices and the virtual (test) device all write into this same shape, so the
 * binding layer above treats them identically.
 */
export class RawInputState {
  readonly keysDown = new Set<string>();
  readonly keyPresses = new Map<string, number>();
  readonly mouseDown = new Uint8Array(MOUSE_BUTTON_COUNT);
  readonly mousePresses = new Uint16Array(MOUSE_BUTTON_COUNT);
  mouseDeltaX = 0;
  mouseDeltaY = 0;
  wheelDelta = 0;
  readonly padAxes = new Float32Array(PAD_AXIS_COUNT);
  readonly padButtons = new Float32Array(PAD_BUTTON_COUNT);
  readonly padPresses = new Uint16Array(PAD_BUTTON_COUNT);
  padConnected = false;
  /** Set whenever this device produced meaningful input; cleared by the input system. */
  activity = false;

  pressKey(code: string): void {
    if (this.keysDown.has(code)) return;
    this.keysDown.add(code);
    this.keyPresses.set(code, (this.keyPresses.get(code) ?? 0) + 1);
    this.activity = true;
  }

  releaseKey(code: string): void {
    this.keysDown.delete(code);
  }

  pressMouse(button: number): void {
    if (button < 0 || button >= MOUSE_BUTTON_COUNT) return;
    if (this.mouseDown[button] === 0) this.mousePresses[button] = this.mousePresses[button] + 1;
    this.mouseDown[button] = 1;
    this.activity = true;
  }

  releaseMouse(button: number): void {
    if (button < 0 || button >= MOUSE_BUTTON_COUNT) return;
    this.mouseDown[button] = 0;
  }

  moveMouse(dx: number, dy: number): void {
    this.mouseDeltaX += dx;
    this.mouseDeltaY += dy;
    if (dx !== 0 || dy !== 0) this.activity = true;
  }

  setPadButton(index: number, value: number): void {
    if (index < 0 || index >= PAD_BUTTON_COUNT) return;
    const wasDown = this.padButtons[index] >= PAD_BUTTON_THRESHOLD;
    const isDown = value >= PAD_BUTTON_THRESHOLD;
    if (isDown && !wasDown) {
      this.padPresses[index] = this.padPresses[index] + 1;
      this.activity = true;
    }
    this.padButtons[index] = value;
  }

  setPadAxis(index: number, value: number): void {
    if (index < 0 || index >= PAD_AXIS_COUNT) return;
    this.padAxes[index] = value;
    if (Math.abs(value) > 0.3) this.activity = true;
  }

  /** Clears press counters after the input system has read them. */
  consumePresses(): void {
    if (this.keyPresses.size > 0) this.keyPresses.clear();
    this.mousePresses.fill(0);
    this.padPresses.fill(0);
  }

  consumeMouseDelta(): void {
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }

  releaseAll(): void {
    this.keysDown.clear();
    this.mouseDown.fill(0);
    this.padButtons.fill(0);
    this.padAxes.fill(0);
  }
}

/** Anything that can feed raw input. `poll` is called once per rendered frame. */
export interface InputSource {
  readonly id: string;
  readonly raw: RawInputState;
  poll?(): void;
}
