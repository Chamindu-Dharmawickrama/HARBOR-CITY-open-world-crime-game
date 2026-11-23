/**
 * Every rebindable input action. Axis actions produce a value in [-1, 1]; button actions are
 * pressed/held/released. Milestones extend these lists as features land.
 */
export const AXIS_ACTIONS = [
  'moveX',
  'moveY',
  'flyY',
  'lookX',
  'lookY',
  'throttle',
  'brake',
  'steer',
] as const;
export const BUTTON_ACTIONS = [
  'sprint',
  'walk',
  'jump',
  'crouch',
  'aim',
  'fire',
  'swapShoulder',
  'cameraMode',
  'pause',
  'interact',
  'handbrake',
  'horn',
  'gearUp',
  'gearDown',
] as const;

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
  walk: 'Walk (hold)',
  jump: 'Jump / climb',
  crouch: 'Crouch (toggle)',
  aim: 'Aim',
  fire: 'Fire / use',
  swapShoulder: 'Swap aim shoulder',
  cameraMode: 'Camera distance',
  pause: 'Pause / menu',
  throttle: 'Accelerate',
  brake: 'Brake / reverse',
  steer: 'Steer right / left',
  interact: 'Enter / exit vehicle',
  handbrake: 'Handbrake',
  horn: 'Horn / siren',
  gearUp: 'Shift up (manual gearbox)',
  gearDown: 'Shift down (manual gearbox)',
};

/**
 * Where an action is used. Rebinding a control removes it only from actions that can be active
 * at the same time (same context, or a global action), so W can drive both on foot and in a car.
 */
export type ActionContext = 'foot' | 'vehicle' | 'global' | 'debug';

export const ACTION_CONTEXT: Record<InputAction, ActionContext> = {
  moveX: 'foot',
  moveY: 'foot',
  sprint: 'foot',
  walk: 'foot',
  jump: 'foot',
  crouch: 'foot',
  aim: 'foot',
  fire: 'foot',
  swapShoulder: 'foot',
  throttle: 'vehicle',
  brake: 'vehicle',
  steer: 'vehicle',
  handbrake: 'vehicle',
  horn: 'vehicle',
  gearUp: 'vehicle',
  gearDown: 'vehicle',
  lookX: 'global',
  lookY: 'global',
  cameraMode: 'global',
  pause: 'global',
  interact: 'global',
  flyY: 'debug',
};

/** True if both actions can be live at once (so one control must not drive both). */
export function actionsConflict(a: InputAction, b: InputAction): boolean {
  const ca = ACTION_CONTEXT[a];
  const cb = ACTION_CONTEXT[b];
  if (ca === 'debug' || cb === 'debug') return ca === cb;
  return ca === cb || ca === 'global' || cb === 'global';
}

export function isAxisAction(action: string): action is AxisAction {
  return (AXIS_ACTIONS as readonly string[]).includes(action);
}

export function isButtonAction(action: string): action is ButtonAction {
  return (BUTTON_ACTIONS as readonly string[]).includes(action);
}
