import { describe, expect, it } from 'vitest';
import { AXIS_ACTIONS, BUTTON_ACTIONS } from '../../core/input/actions';
import { DEFAULT_BINDINGS, rebind } from '../../core/input/bindings';
import { assignSlot, clearSlot, CONTROL_ROWS, rowSlots, type ControlRow } from './control-rows';

const row = (action: ControlRow['action'], sign: 1 | -1 = 1): ControlRow => {
  const found = CONTROL_ROWS.find((r) => r.action === action && r.sign === sign);
  if (!found) throw new Error(`${action} ${sign}`);
  return found;
};

describe('controls panel rows', () => {
  it('covers every action (axes in both directions)', () => {
    for (const action of BUTTON_ACTIONS) expect(CONTROL_ROWS.some((r) => r.action === action)).toBe(true);
    for (const action of AXIS_ACTIONS) {
      expect(CONTROL_ROWS.some((r) => r.action === action && r.sign === 1)).toBe(true);
      expect(CONTROL_ROWS.some((r) => r.action === action && r.sign === -1)).toBe(true);
    }
  });

  it('splits axis bindings into halves by device', () => {
    const forward = rowSlots(DEFAULT_BINDINGS, row('moveY', 1), 'kbm').map((i) => DEFAULT_BINDINGS.moveY[i]);
    expect(forward.map((b) => b?.kind === 'key' && b.code)).toEqual(['KeyW', 'ArrowUp']);
    const back = rowSlots(DEFAULT_BINDINGS, row('moveY', -1), 'kbm').map((i) => DEFAULT_BINDINGS.moveY[i]);
    expect(back.map((b) => b?.kind === 'key' && b.code)).toEqual(['KeyS', 'ArrowDown']);
    // The left stick's Y axis drives both directions, so it shows in both rows.
    expect(rowSlots(DEFAULT_BINDINGS, row('moveY', 1), 'pad')).toEqual(
      rowSlots(DEFAULT_BINDINGS, row('moveY', -1), 'pad'),
    );
    expect(rowSlots(DEFAULT_BINDINGS, row('moveY', 1), 'pad')).toHaveLength(1);
    // D-pad buttons on the debug fly axis are halves.
    expect(rowSlots(DEFAULT_BINDINGS, row('flyY', 1), 'pad')).not.toEqual(
      rowSlots(DEFAULT_BINDINGS, row('flyY', -1), 'pad'),
    );
  });

  it('assigns a key to a slot, removing it from other actions and the other half of the axis', () => {
    let map = assignSlot(DEFAULT_BINDINGS, row('moveY', -1), 'kbm', 0, { kind: 'key', code: 'KeyW' });
    expect(map.moveY.filter((b) => b.kind === 'key' && b.code === 'KeyW')).toEqual([
      { kind: 'key', code: 'KeyW', scale: -1 },
    ]);
    expect(map.moveY.some((b) => b.kind === 'key' && b.code === 'KeyS')).toBe(false);
    map = assignSlot(map, row('jump'), 'kbm', 1, { kind: 'key', code: 'KeyW' });
    expect(map.moveY.some((b) => b.kind === 'key' && b.code === 'KeyW')).toBe(false);
    expect(map.jump.some((b) => b.kind === 'key' && b.code === 'KeyW')).toBe(true);
  });

  it('pad axes take the row direction into account', () => {
    // Stick pushed up (−Y) for "Move forward" (+1) ⇒ scale −1 on axis 1, like the default.
    const map = assignSlot(DEFAULT_BINDINGS, row('moveY', 1), 'pad', 0, {
      kind: 'padAxis',
      index: 1,
      direction: -1,
    });
    expect(map.moveY.filter((b) => b.kind === 'padAxis')).toEqual([{ kind: 'padAxis', index: 1, scale: -1 }]);
    expect(() =>
      assignSlot(DEFAULT_BINDINGS, row('jump'), 'kbm', 0, { kind: 'padButton', index: 3 }),
    ).toThrow();
  });

  it('clears a slot and ignores empty slots', () => {
    const map = clearSlot(DEFAULT_BINDINGS, row('jump'), 'kbm', 0);
    expect(map.jump.some((b) => b.kind === 'key')).toBe(false);
    expect(clearSlot(map, row('jump'), 'kbm', 1)).toBe(map);
  });

  it('rebind de-duplicates within the action itself', () => {
    const map = rebind(DEFAULT_BINDINGS, 'moveX', DEFAULT_BINDINGS.moveX.length, {
      kind: 'key',
      code: 'KeyA',
      scale: 1,
    });
    expect(map.moveX.filter((b) => b.kind === 'key' && b.code === 'KeyA')).toEqual([
      { kind: 'key', code: 'KeyA', scale: 1 },
    ]);
  });
});
