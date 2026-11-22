import { AXIS_ACTIONS, BUTTON_ACTIONS, type InputAction } from './actions';

/**
 * A binding maps one physical control to an action. For axis actions, `scale` gives the
 * contribution (e.g. W → moveY +1, S → moveY -1). Pad axes use the standard gamepad mapping:
 * 0/1 left stick X/Y, 2/3 right stick X/Y (Y is +down).
 */
export type Binding =
  | { kind: 'key'; code: string; scale: number }
  | { kind: 'mouseButton'; button: number; scale: number }
  | { kind: 'padButton'; index: number; scale: number }
  | { kind: 'padAxis'; index: number; scale: number };

export type BindingMap = Record<InputAction, Binding[]>;

const key = (code: string, scale = 1): Binding => ({ kind: 'key', code, scale });
const mouse = (button: number): Binding => ({ kind: 'mouseButton', button, scale: 1 });
const padButton = (index: number, scale = 1): Binding => ({ kind: 'padButton', index, scale });
const padAxis = (index: number, scale = 1): Binding => ({ kind: 'padAxis', index, scale });

export const DEFAULT_BINDINGS: BindingMap = {
  moveX: [key('KeyD'), key('KeyA', -1), key('ArrowRight'), key('ArrowLeft', -1), padAxis(0)],
  moveY: [key('KeyW'), key('KeyS', -1), key('ArrowUp'), key('ArrowDown', -1), padAxis(1, -1)],
  flyY: [key('KeyE'), key('Space'), key('KeyQ', -1), key('ControlLeft', -1), padButton(5), padButton(4, -1)],
  lookX: [padAxis(2)],
  lookY: [padAxis(3, -1)],
  sprint: [key('ShiftLeft'), key('ShiftRight'), padButton(10)],
  fire: [mouse(0), padButton(7)],
  pause: [key('KeyP'), padButton(9)],
};

export function cloneBindings(map: BindingMap): BindingMap {
  const copy = {} as BindingMap;
  for (const action of [...AXIS_ACTIONS, ...BUTTON_ACTIONS]) {
    copy[action] = map[action].map((b) => ({ ...b }));
  }
  return copy;
}

export function bindingsEqual(a: Binding, b: Binding): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'key':
      return b.kind === 'key' && a.code === b.code;
    case 'mouseButton':
      return b.kind === 'mouseButton' && a.button === b.button;
    case 'padButton':
      return b.kind === 'padButton' && a.index === b.index;
    case 'padAxis':
      return b.kind === 'padAxis' && a.index === b.index && Math.sign(a.scale) === Math.sign(b.scale);
  }
}

/**
 * Returns a new map where slot `slot` of `action` is replaced by `binding` (or appended if
 * slot === length). The same physical control is removed from every other action so one
 * key never triggers two actions.
 */
export function rebind(map: BindingMap, action: InputAction, slot: number, binding: Binding): BindingMap {
  const next = cloneBindings(map);
  for (const other of [...AXIS_ACTIONS, ...BUTTON_ACTIONS]) {
    if (other === action) continue;
    next[other] = next[other].filter((b) => !bindingsEqual(b, binding));
  }
  const list = next[action];
  if (slot < 0 || slot > list.length) throw new Error(`rebind: slot ${slot} out of range for ${action}`);
  list[slot] = { ...binding };
  return next;
}

export function unbind(map: BindingMap, action: InputAction, slot: number): BindingMap {
  const next = cloneBindings(map);
  next[action] = next[action].filter((_, i) => i !== slot);
  return next;
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['scale'] !== 'number' || !Number.isFinite(v['scale'])) return false;
  switch (v['kind']) {
    case 'key':
      return typeof v['code'] === 'string' && v['code'].length > 0;
    case 'mouseButton':
      return Number.isInteger(v['button']);
    case 'padButton':
    case 'padAxis':
      return Number.isInteger(v['index']);
    default:
      return false;
  }
}

export function serializeBindings(map: BindingMap): string {
  return JSON.stringify(map);
}

/**
 * Parses stored bindings. Unknown actions are dropped, invalid entries are skipped, and any
 * action missing from the stored data falls back to the defaults (so new actions added in
 * later versions get default bindings automatically).
 */
export function parseBindings(json: string, defaults: BindingMap = DEFAULT_BINDINGS): BindingMap {
  const result = cloneBindings(defaults);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return result;
  }
  if (typeof data !== 'object' || data === null) return result;
  const record = data as Record<string, unknown>;
  for (const action of [...AXIS_ACTIONS, ...BUTTON_ACTIONS]) {
    const stored = record[action];
    if (Array.isArray(stored)) result[action] = stored.filter(isBinding).map((b) => ({ ...b }));
  }
  return result;
}

const PAD_BUTTON_NAMES = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'Back',
  'Start',
  'LS',
  'RS',
  'D-Up',
  'D-Down',
  'D-Left',
  'D-Right',
  'Home',
];
const PAD_AXIS_NAMES = ['LS X', 'LS Y', 'RS X', 'RS Y'];

export function describeBinding(binding: Binding): string {
  switch (binding.kind) {
    case 'key':
      return binding.code.replace(/^Key/, '').replace(/^Digit/, '');
    case 'mouseButton':
      return (
        ['Mouse L', 'Mouse M', 'Mouse R', 'Mouse 4', 'Mouse 5'][binding.button] ?? `Mouse ${binding.button}`
      );
    case 'padButton':
      return `Pad ${PAD_BUTTON_NAMES[binding.index] ?? binding.index}`;
    case 'padAxis':
      return `Pad ${PAD_AXIS_NAMES[binding.index] ?? `Axis ${binding.index}`}${binding.scale < 0 ? '-' : '+'}`;
  }
}
