import { isButtonAction, type InputAction } from '../../core/input/actions';
import { rebind, unbind, type Binding, type BindingMap } from '../../core/input/bindings';

/** One line of the controls panel: a button action, or one direction of an axis action. */
export interface ControlRow {
  action: InputAction;
  /** +1 / −1 for axis halves (the binding scale sign), +1 for buttons. */
  sign: 1 | -1;
  label: string;
  /** Rows that only make sense on a gamepad (stick look). */
  padOnly?: boolean;
  debug?: boolean;
}

export const CONTROL_ROWS: readonly ControlRow[] = [
  { action: 'moveY', sign: 1, label: 'Move forward' },
  { action: 'moveY', sign: -1, label: 'Move back' },
  { action: 'moveX', sign: -1, label: 'Move left' },
  { action: 'moveX', sign: 1, label: 'Move right' },
  { action: 'sprint', sign: 1, label: 'Sprint' },
  { action: 'walk', sign: 1, label: 'Walk (hold)' },
  { action: 'jump', sign: 1, label: 'Jump / climb' },
  { action: 'crouch', sign: 1, label: 'Crouch' },
  { action: 'aim', sign: 1, label: 'Aim' },
  { action: 'fire', sign: 1, label: 'Fire / use' },
  { action: 'swapShoulder', sign: 1, label: 'Swap shoulder' },
  { action: 'cameraMode', sign: 1, label: 'Camera distance' },
  { action: 'pause', sign: 1, label: 'Pause / menu' },
  { action: 'lookX', sign: -1, label: 'Look left (stick)', padOnly: true },
  { action: 'lookX', sign: 1, label: 'Look right (stick)', padOnly: true },
  { action: 'lookY', sign: 1, label: 'Look up (stick)', padOnly: true },
  { action: 'lookY', sign: -1, label: 'Look down (stick)', padOnly: true },
  { action: 'flyY', sign: 1, label: 'Fly up (debug camera)', debug: true },
  { action: 'flyY', sign: -1, label: 'Fly down (debug camera)', debug: true },
];

export type SlotDevice = 'kbm' | 'pad';

/** Keyboard/mouse slots and gamepad slots shown per row. */
export const SLOTS_PER_DEVICE: Readonly<Record<SlotDevice, number>> = { kbm: 2, pad: 1 };

export function deviceOf(binding: Binding): SlotDevice {
  return binding.kind === 'key' || binding.kind === 'mouseButton' ? 'kbm' : 'pad';
}

/**
 * Absolute indices into `map[row.action]` of the bindings shown in this row, by device. A stick
 * axis bound to an axis action drives both directions, so it shows in both of its rows.
 */
export function rowSlots(map: BindingMap, row: ControlRow, device: SlotDevice): number[] {
  const out: number[] = [];
  const button = isButtonAction(row.action);
  map[row.action].forEach((b, i) => {
    if (deviceOf(b) !== device) return;
    if (button || b.kind === 'padAxis' || Math.sign(b.scale) === row.sign) out.push(i);
  });
  return out;
}

/** A captured physical control, before it is given the row's direction. */
export type CapturedControl =
  | { kind: 'key'; code: string }
  | { kind: 'mouseButton'; button: number }
  | { kind: 'padButton'; index: number }
  /** `direction` is the sign the axis was pushed (pad Y axes are +down). */
  | { kind: 'padAxis'; index: number; direction: 1 | -1 };

export function bindingFor(row: ControlRow, control: CapturedControl): Binding {
  switch (control.kind) {
    case 'key':
      return { kind: 'key', code: control.code, scale: row.sign };
    case 'mouseButton':
      return { kind: 'mouseButton', button: control.button, scale: row.sign };
    case 'padButton':
      return { kind: 'padButton', index: control.index, scale: row.sign };
    case 'padAxis':
      return { kind: 'padAxis', index: control.index, scale: row.sign * control.direction };
  }
}

/**
 * Assigns a captured control to the n-th slot of a row's device column (replacing what is there
 * or adding a new binding). The control is removed from every other action and slot.
 */
export function assignSlot(
  map: BindingMap,
  row: ControlRow,
  device: SlotDevice,
  ordinal: number,
  control: CapturedControl,
): BindingMap {
  const binding = bindingFor(row, control);
  if (deviceOf(binding) !== device)
    throw new Error(`assignSlot: ${binding.kind} cannot go in a ${device} slot`);
  const slots = rowSlots(map, row, device);
  const absolute = ordinal < slots.length ? slots[ordinal] : map[row.action].length;
  return rebind(map, row.action, absolute, binding);
}

export function clearSlot(map: BindingMap, row: ControlRow, device: SlotDevice, ordinal: number): BindingMap {
  const slots = rowSlots(map, row, device);
  if (ordinal >= slots.length) return map;
  return unbind(map, row.action, slots[ordinal]);
}
