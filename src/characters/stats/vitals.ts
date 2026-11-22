/** Health, armour and stamina of a character, plus the pure rules that change them. */
export interface Vitals {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  stamina: number;
  maxStamina: number;
  /** Set when stamina hits zero; sprinting is blocked until stamina recovers to the threshold. */
  exhausted: boolean;
  /** Seconds before stamina starts regenerating after the last drain. */
  regenDelay: number;
}

export const STAMINA = {
  regenPerSecond: 22,
  regenDelay: 0.8,
  recoverThreshold: 25,
} as const;

/** Fraction of incoming damage absorbed by armour while it lasts. */
export const ARMOR_ABSORB = 2 / 3;

export function createVitals(maxHealth = 100, maxArmor = 100, maxStamina = 100): Vitals {
  return {
    health: maxHealth,
    maxHealth,
    armor: 0,
    maxArmor,
    stamina: maxStamina,
    maxStamina,
    exhausted: false,
    regenDelay: 0,
  };
}

export interface DamageResult {
  /** Health actually removed. */
  dealt: number;
  /** Damage soaked by armour. */
  absorbed: number;
  died: boolean;
}

/** Applies damage; armour soaks ARMOR_ABSORB of it until depleted (bypassArmor skips that). */
export function applyDamage(v: Vitals, amount: number, bypassArmor = false): DamageResult {
  if (v.health <= 0 || amount <= 0) return { dealt: 0, absorbed: 0, died: false };
  let absorbed = 0;
  if (!bypassArmor && v.armor > 0) {
    absorbed = Math.min(v.armor, amount * ARMOR_ABSORB);
    v.armor -= absorbed;
  }
  const dealt = Math.min(v.health, amount - absorbed);
  v.health -= dealt;
  return { dealt, absorbed, died: v.health <= 0 };
}

export function heal(v: Vitals, amount: number): void {
  if (v.health <= 0) return;
  v.health = Math.min(v.maxHealth, v.health + amount);
}

export function addArmor(v: Vitals, amount: number): void {
  v.armor = Math.min(v.maxArmor, v.armor + amount);
}

/** Resets to full health and stamina (respawn). Armour is kept as-is. */
export function revive(v: Vitals): void {
  v.health = v.maxHealth;
  v.stamina = v.maxStamina;
  v.exhausted = false;
  v.regenDelay = 0;
}

/** True if the character may sprint right now. */
export function canSprint(v: Vitals): boolean {
  return v.health > 0 && !v.exhausted && v.stamina > 0;
}

/**
 * Advances stamina: drains at `drainPerSecond` (0 when resting), otherwise regenerates after
 * a short delay. Reaching zero sets `exhausted` until stamina recovers past the threshold.
 */
export function updateStamina(v: Vitals, dt: number, drainPerSecond: number): void {
  if (drainPerSecond > 0) {
    v.stamina = Math.max(0, v.stamina - drainPerSecond * dt);
    v.regenDelay = STAMINA.regenDelay;
    if (v.stamina === 0) v.exhausted = true;
    return;
  }
  if (v.regenDelay > 0) {
    v.regenDelay = Math.max(0, v.regenDelay - dt);
    return;
  }
  v.stamina = Math.min(v.maxStamina, v.stamina + STAMINA.regenPerSecond * dt);
  if (v.exhausted && v.stamina >= STAMINA.recoverThreshold) v.exhausted = false;
}

/** Falls up to this height are harmless; at the lethal height damage exceeds full health. */
export const FALL = {
  safeHeight: 3,
  lethalHeight: 25,
  /** Damage at the lethal height (more than max health so armour cannot save a deadly fall). */
  lethalDamage: 115,
} as const;

/**
 * Damage from landing at vertical speed `impactSpeed` (m/s, positive down) under gravity `g`.
 * The equivalent drop height v²/2g is mapped linearly between the safe and lethal heights.
 */
export function fallDamage(impactSpeed: number, gravity: number): number {
  if (impactSpeed <= 0) return 0;
  const height = (impactSpeed * impactSpeed) / (2 * gravity);
  const t = (height - FALL.safeHeight) / (FALL.lethalHeight - FALL.safeHeight);
  return t <= 0 ? 0 : Math.min(1.5, t) * FALL.lethalDamage;
}
