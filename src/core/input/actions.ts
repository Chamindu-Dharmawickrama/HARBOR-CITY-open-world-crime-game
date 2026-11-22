/**
 * Every rebindable input action. Axis actions produce a value in [-1, 1]; button actions are
 * pressed/held/released. Milestones extend these lists as features land.
 */
export const AXIS_ACTIONS = ['moveX', 'moveY', 'flyY', 'lookX', 'lookY'] as const;
export const BUTTON_ACTIONS = ['sprint', 'fire', 'pause'] as const;

export type AxisAction = (typeof AXIS_ACTIONS)[number];
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export type InputAction = AxisAction | ButtonAction;

export const ACTION_LABELS: Record<InputAction, string> = {
  moveX: 'Move right / left',
  moveY: 'Move forward / back',
  flyY: 'Fly up / down (debug camera)',
  lookX: 'Look right / left (stick)',
  lookY: 'Look up / down (stick)',
  sprint: 'Sprint / fast',
  fire: 'Fire / use',
  pause: 'Pause',
};

export function isAxisAction(action: string): action is AxisAction {
  return (AXIS_ACTIONS as readonly string[]).includes(action);
}

export function isButtonAction(action: string): action is ButtonAction {
  return (BUTTON_ACTIONS as readonly string[]).includes(action);
}
