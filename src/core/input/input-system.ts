import { AXIS_ACTIONS, BUTTON_ACTIONS, type AxisAction, type ButtonAction } from './actions';
import { cloneBindings, DEFAULT_BINDINGS, type Binding, type BindingMap } from './bindings';
import { applyRadialDeadzone, lookCurve, type Vec2Out } from './deadzone';
import { PAD_AXIS_COUNT, PAD_BUTTON_THRESHOLD, type InputSource, type RawInputState } from './raw-input';

export type InputDeviceKind = 'keyboardMouse' | 'gamepad';

export interface InputSettings {
  /** Radians of look per pixel of mouse motion. */
  mouseSensitivity: number;
  invertY: boolean;
  /** Radians per second at full right-stick deflection. */
  padLookSpeed: number;
  stickDeadzone: number;
  stickOuter: number;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  mouseSensitivity: 0.0022,
  invertY: false,
  padLookSpeed: 3.4,
  stickDeadzone: 0.15,
  stickOuter: 0.95,
};

const AXIS_INDEX = new Map<AxisAction, number>(AXIS_ACTIONS.map((a, i) => [a, i]));
const BUTTON_INDEX = new Map<ButtonAction, number>(BUTTON_ACTIONS.map((b, i) => [b, i]));

/**
 * Maps raw device state to actions through the binding map.
 *
 * Timing model: `update()` runs once per rendered frame (before fixed steps) and refreshes axis
 * values and held state. Button press/release edges are latched until the next fixed step calls
 * `beginFixedStep()`, so a tap is seen by exactly one fixed step even when a frame runs zero or
 * several steps. Render-rate consumers (cameras) use `pressedThisFrame` and `readLook`.
 */
export class InputSystem {
  enabled = true;
  activeDevice: InputDeviceKind = 'keyboardMouse';
  settings: InputSettings;

  private bindings: BindingMap;
  private readonly axisValues = new Float32Array(AXIS_ACTIONS.length);
  private readonly buttonDown = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly framePressed = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly frameReleased = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly pendingPressed = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly pendingReleased = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly stepPressed = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly stepReleased = new Uint8Array(BUTTON_ACTIONS.length);
  private readonly processedAxes: Float32Array[];
  private pendingLookX = 0;
  private pendingLookY = 0;
  private readonly stick: Vec2Out = { x: 0, y: 0 };

  constructor(
    private readonly sources: readonly (InputSource & { kind: InputDeviceKind | 'virtual' })[],
    bindings: BindingMap = DEFAULT_BINDINGS,
    settings: InputSettings = DEFAULT_INPUT_SETTINGS,
  ) {
    this.bindings = cloneBindings(bindings);
    this.settings = { ...settings };
    this.processedAxes = sources.map(() => new Float32Array(PAD_AXIS_COUNT));
  }

  getBindings(): BindingMap {
    return cloneBindings(this.bindings);
  }

  setBindings(map: BindingMap): void {
    this.bindings = cloneBindings(map);
  }

  /** Once per rendered frame. */
  update(): void {
    for (const source of this.sources) source.poll?.();
    for (let s = 0; s < this.sources.length; s++) this.processPadAxes(s);

    for (let a = 0; a < AXIS_ACTIONS.length; a++) {
      const action = AXIS_ACTIONS[a];
      let value = 0;
      for (let s = 0; s < this.sources.length; s++) {
        for (const binding of this.bindings[action]) value += this.bindingValue(s, binding);
      }
      this.axisValues[a] = this.enabled ? Math.max(-1, Math.min(1, value)) : 0;
    }

    for (let b = 0; b < BUTTON_ACTIONS.length; b++) {
      const action = BUTTON_ACTIONS[b];
      let down = false;
      let pressedEdge = false;
      for (let s = 0; s < this.sources.length; s++) {
        const raw = (this.sources[s] as InputSource).raw;
        for (const binding of this.bindings[action]) {
          if (this.bindingValue(s, binding) * Math.sign(binding.scale || 1) >= PAD_BUTTON_THRESHOLD)
            down = true;
          if (this.bindingPressedSinceLast(raw, binding)) pressedEdge = true;
        }
      }
      if (!this.enabled) {
        down = false;
        pressedEdge = false;
      }
      const wasDown = this.buttonDown[b] === 1;
      const pressed = pressedEdge || (down && !wasDown);
      const released = wasDown && !down;
      this.buttonDown[b] = down ? 1 : 0;
      this.framePressed[b] = pressed ? 1 : 0;
      this.frameReleased[b] = released ? 1 : 0;
      if (pressed) this.pendingPressed[b] = 1;
      if (released) this.pendingReleased[b] = 1;
    }

    const { mouseSensitivity, invertY } = this.settings;
    for (const source of this.sources) {
      const raw = source.raw;
      if (this.enabled) {
        this.pendingLookX += raw.mouseDeltaX * mouseSensitivity;
        this.pendingLookY += -raw.mouseDeltaY * mouseSensitivity * (invertY ? -1 : 1);
      }
      if (raw.activity) {
        if (source.kind !== 'virtual') this.activeDevice = source.kind;
        raw.activity = false;
      }
      raw.consumePresses();
      raw.consumeMouseDelta();
    }
  }

  /** Call at the start of every fixed step: latches the press/release edges for that step. */
  beginFixedStep(): void {
    this.stepPressed.set(this.pendingPressed);
    this.stepReleased.set(this.pendingReleased);
    this.pendingPressed.fill(0);
    this.pendingReleased.fill(0);
  }

  /** Drops latched edges and look motion (used when pausing or opening the console). */
  clearPending(): void {
    this.pendingPressed.fill(0);
    this.pendingReleased.fill(0);
    this.stepPressed.fill(0);
    this.stepReleased.fill(0);
    this.pendingLookX = 0;
    this.pendingLookY = 0;
  }

  axis(action: AxisAction): number {
    return this.axisValues[AXIS_INDEX.get(action) as number];
  }

  down(action: ButtonAction): boolean {
    return this.buttonDown[BUTTON_INDEX.get(action) as number] === 1;
  }

  /** True during the one fixed step that follows a press. */
  pressed(action: ButtonAction): boolean {
    return this.stepPressed[BUTTON_INDEX.get(action) as number] === 1;
  }

  released(action: ButtonAction): boolean {
    return this.stepReleased[BUTTON_INDEX.get(action) as number] === 1;
  }

  /** True during the one rendered frame that follows a press (for render-rate and meta logic). */
  pressedThisFrame(action: ButtonAction): boolean {
    return this.framePressed[BUTTON_INDEX.get(action) as number] === 1;
  }

  /**
   * Look delta in radians since the last call: accumulated mouse motion plus right-stick rate
   * integrated over `dt`. +x = look right, +y = look up.
   */
  readLook(dt: number, out: Vec2Out): Vec2Out {
    const speed = this.settings.padLookSpeed * dt;
    const invert = this.settings.invertY ? -1 : 1;
    out.x = this.pendingLookX + lookCurve(this.axis('lookX')) * speed;
    out.y = this.pendingLookY + lookCurve(this.axis('lookY')) * speed * invert;
    this.pendingLookX = 0;
    this.pendingLookY = 0;
    return out;
  }

  private processPadAxes(sourceIndex: number): void {
    const raw = (this.sources[sourceIndex] as InputSource).raw;
    const out = this.processedAxes[sourceIndex];
    const { stickDeadzone, stickOuter } = this.settings;
    for (let pair = 0; pair < 2; pair++) {
      const ix = pair * 2;
      applyRadialDeadzone(raw.padAxes[ix], raw.padAxes[ix + 1], stickDeadzone, stickOuter, this.stick);
      out[ix] = this.stick.x;
      out[ix + 1] = this.stick.y;
    }
    for (let i = 4; i < PAD_AXIS_COUNT; i++) {
      const v = raw.padAxes[i];
      out[i] = Math.abs(v) < stickDeadzone ? 0 : v;
    }
  }

  private bindingValue(sourceIndex: number, binding: Binding): number {
    const raw = (this.sources[sourceIndex] as InputSource).raw;
    switch (binding.kind) {
      case 'key':
        return raw.keysDown.has(binding.code) ? binding.scale : 0;
      case 'mouseButton':
        return raw.mouseDown[binding.button] === 1 ? binding.scale : 0;
      case 'padButton':
        return (raw.padButtons[binding.index] ?? 0) * binding.scale;
      case 'padAxis':
        return (this.processedAxes[sourceIndex][binding.index] ?? 0) * binding.scale;
    }
  }

  private bindingPressedSinceLast(raw: RawInputState, binding: Binding): boolean {
    switch (binding.kind) {
      case 'key':
        return (raw.keyPresses.get(binding.code) ?? 0) > 0;
      case 'mouseButton':
        return (raw.mousePresses[binding.button] ?? 0) > 0;
      case 'padButton':
        return (raw.padPresses[binding.index] ?? 0) > 0;
      case 'padAxis':
        return false;
    }
  }
}
