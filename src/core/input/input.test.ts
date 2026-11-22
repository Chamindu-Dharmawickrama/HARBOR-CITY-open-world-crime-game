import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  bindingsEqual,
  describeBinding,
  parseBindings,
  rebind,
  serializeBindings,
  unbind,
} from './bindings';
import { applyRadialDeadzone, lookCurve } from './deadzone';
import { InputSystem } from './input-system';
import { RawInputState } from './raw-input';
import { VirtualInputDevice } from './virtual-device';

function setup(): {
  input: InputSystem;
  device: VirtualInputDevice;
  pad: { id: string; kind: 'gamepad'; raw: RawInputState };
} {
  const device = new VirtualInputDevice();
  const pad = { id: 'fakepad', kind: 'gamepad' as const, raw: new RawInputState() };
  const input = new InputSystem([device, pad], DEFAULT_BINDINGS);
  return { input, device, pad };
}

describe('deadzone', () => {
  it('zeroes inside the inner radius and rescales beyond it', () => {
    const out = { x: 9, y: 9 };
    applyRadialDeadzone(0.1, 0.05, 0.15, 0.95, out);
    expect(out).toEqual({ x: 0, y: 0 });
    applyRadialDeadzone(1, 0, 0.15, 0.95, out);
    expect(out.x).toBeCloseTo(1);
    applyRadialDeadzone(0.55, 0, 0.15, 0.95, out);
    expect(out.x).toBeCloseTo(0.5);
  });

  it('preserves direction', () => {
    const out = { x: 0, y: 0 };
    applyRadialDeadzone(0.6, 0.6, 0.15, 0.95, out);
    expect(out.x).toBeCloseTo(out.y);
    expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(1);
  });

  it('lookCurve keeps sign and endpoints', () => {
    expect(lookCurve(1)).toBe(1);
    expect(lookCurve(-1)).toBe(-1);
    expect(Math.abs(lookCurve(0.5))).toBeLessThan(0.5);
  });
});

describe('bindings', () => {
  it('serialises and parses round-trip', () => {
    const parsed = parseBindings(serializeBindings(DEFAULT_BINDINGS));
    expect(parsed).toEqual(DEFAULT_BINDINGS);
  });

  it('falls back to defaults for missing or invalid data', () => {
    expect(parseBindings('not json')).toEqual(DEFAULT_BINDINGS);
    const partial = parseBindings(
      JSON.stringify({ fire: [{ kind: 'key', code: 'KeyF', scale: 1 }, { bogus: 1 }] }),
    );
    expect(partial.fire).toEqual([{ kind: 'key', code: 'KeyF', scale: 1 }]);
    expect(partial.moveX).toEqual(DEFAULT_BINDINGS.moveX);
  });

  it('rebind removes the control from other actions', () => {
    const next = rebind(DEFAULT_BINDINGS, 'fire', 0, { kind: 'key', code: 'KeyW', scale: 1 });
    expect(next.fire[0]).toEqual({ kind: 'key', code: 'KeyW', scale: 1 });
    expect(next.moveY.some((b) => b.kind === 'key' && b.code === 'KeyW')).toBe(false);
    expect(DEFAULT_BINDINGS.moveY.some((b) => b.kind === 'key' && b.code === 'KeyW')).toBe(true);
    expect(() => rebind(DEFAULT_BINDINGS, 'fire', 99, { kind: 'key', code: 'KeyX', scale: 1 })).toThrow();
  });

  it('unbind removes one slot', () => {
    const next = unbind(DEFAULT_BINDINGS, 'fire', 0);
    expect(next.fire).toHaveLength(DEFAULT_BINDINGS.fire.length - 1);
  });

  it('bindingsEqual and describeBinding', () => {
    expect(
      bindingsEqual({ kind: 'key', code: 'KeyA', scale: 1 }, { kind: 'key', code: 'KeyA', scale: -1 }),
    ).toBe(true);
    expect(
      bindingsEqual({ kind: 'padAxis', index: 0, scale: 1 }, { kind: 'padAxis', index: 0, scale: -1 }),
    ).toBe(false);
    expect(describeBinding({ kind: 'key', code: 'KeyW', scale: 1 })).toBe('W');
    expect(describeBinding({ kind: 'padButton', index: 0, scale: 1 })).toBe('Pad A');
    expect(describeBinding({ kind: 'mouseButton', button: 0, scale: 1 })).toBe('Mouse L');
  });
});

describe('InputSystem', () => {
  it('maps keys to axes with opposing keys cancelling', () => {
    const { input, device } = setup();
    device.keyDown('KeyW');
    input.update();
    expect(input.axis('moveY')).toBe(1);
    device.keyDown('KeyS');
    input.update();
    expect(input.axis('moveY')).toBe(0);
    device.keyUp('KeyW');
    input.update();
    expect(input.axis('moveY')).toBe(-1);
  });

  it('combines sources and clamps to [-1, 1]', () => {
    const { input, device, pad } = setup();
    device.keyDown('KeyD');
    pad.raw.setPadAxis(0, 1);
    input.update();
    expect(input.axis('moveX')).toBe(1);
  });

  it('applies the stick deadzone', () => {
    const { input, pad } = setup();
    pad.raw.setPadAxis(0, 0.1);
    input.update();
    expect(input.axis('moveX')).toBe(0);
    pad.raw.setPadAxis(1, -1);
    input.update();
    expect(input.axis('moveY')).toBeCloseTo(1);
  });

  it('latches a tap for exactly one fixed step, even with zero steps in between frames', () => {
    const { input, device } = setup();
    device.mouseButton(0, true);
    device.mouseButton(0, false);
    input.update();
    input.update();
    input.beginFixedStep();
    expect(input.pressed('fire')).toBe(true);
    input.beginFixedStep();
    expect(input.pressed('fire')).toBe(false);
  });

  it('frame edges and held state', () => {
    const { input, device } = setup();
    device.keyDown('KeyP');
    input.update();
    expect(input.pressedThisFrame('pause')).toBe(true);
    expect(input.down('pause')).toBe(true);
    input.update();
    expect(input.pressedThisFrame('pause')).toBe(false);
    expect(input.down('pause')).toBe(true);
    device.keyUp('KeyP');
    input.update();
    input.beginFixedStep();
    expect(input.released('pause')).toBe(true);
  });

  it('analog trigger counts as a button above threshold', () => {
    const { input, pad } = setup();
    pad.raw.setPadButton(7, 0.3);
    input.update();
    expect(input.down('fire')).toBe(false);
    pad.raw.setPadButton(7, 0.9);
    input.update();
    expect(input.down('fire')).toBe(true);
  });

  it('readLook drains mouse motion and integrates stick rate', () => {
    const { input, device, pad } = setup();
    device.mouseMove(100, -50);
    input.update();
    const out = { x: 0, y: 0 };
    input.readLook(1 / 60, out);
    expect(out.x).toBeCloseTo(100 * input.settings.mouseSensitivity);
    expect(out.y).toBeCloseTo(50 * input.settings.mouseSensitivity);
    input.readLook(1 / 60, out);
    expect(out.x).toBe(0);
    pad.raw.setPadAxis(2, 1);
    input.update();
    input.readLook(0.5, out);
    expect(out.x).toBeCloseTo(input.settings.padLookSpeed * 0.5, 1);
  });

  it('invertY flips vertical look', () => {
    const { input, device } = setup();
    input.settings.invertY = true;
    device.mouseMove(0, -10);
    input.update();
    const out = { x: 0, y: 0 };
    input.readLook(1 / 60, out);
    expect(out.y).toBeLessThan(0);
  });

  it('disabled input reads as neutral and drops presses', () => {
    const { input, device } = setup();
    input.enabled = false;
    device.keyDown('KeyW');
    device.mouseButton(0, true);
    input.update();
    input.beginFixedStep();
    expect(input.axis('moveY')).toBe(0);
    expect(input.pressed('fire')).toBe(false);
  });

  it('tracks the active device kind (virtual input does not change it)', () => {
    const { input, device, pad } = setup();
    expect(input.activeDevice).toBe('keyboardMouse');
    pad.raw.setPadButton(0, 1);
    input.update();
    expect(input.activeDevice).toBe('gamepad');
    device.keyDown('KeyW');
    input.update();
    expect(input.activeDevice).toBe('gamepad');
  });

  it('respects rebinding', () => {
    const { input, device } = setup();
    input.setBindings(rebind(DEFAULT_BINDINGS, 'fire', 0, { kind: 'key', code: 'KeyF', scale: 1 }));
    device.keyDown('KeyF');
    input.update();
    expect(input.down('fire')).toBe(true);
  });
});
