import { cloneBindings, DEFAULT_BINDINGS, parseBindings, type BindingMap } from '../core/input/bindings';
import { DEFAULT_INPUT_SETTINGS } from '../core/input/input-system';

/** Bump when the stored shape changes; add a migration step below. */
export const SETTINGS_VERSION = 1;
export const SETTINGS_KEY = 'harbor-city:settings';

export interface ControlSettings {
  mouseSensitivity: number;
  invertY: boolean;
  padLookSpeed: number;
}

export interface GameSettings {
  version: typeof SETTINGS_VERSION;
  bindings: BindingMap;
  controls: ControlSettings;
}

/** Valid ranges (also used by the settings UI sliders). */
export const CONTROL_LIMITS = {
  mouseSensitivity: { min: 0.0004, max: 0.008, step: 0.0001 },
  padLookSpeed: { min: 1, max: 7, step: 0.1 },
} as const;

/** The subset of Web Storage the store needs (localStorage, or a fake in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultSettings(): GameSettings {
  return {
    version: SETTINGS_VERSION,
    bindings: cloneBindings(DEFAULT_BINDINGS),
    controls: {
      mouseSensitivity: DEFAULT_INPUT_SETTINGS.mouseSensitivity,
      invertY: DEFAULT_INPUT_SETTINGS.invertY,
      padLookSpeed: DEFAULT_INPUT_SETTINGS.padLookSpeed,
    },
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Validates and normalises parsed JSON of any known version into current settings. */
export function migrateSettings(data: unknown): GameSettings {
  const result = defaultSettings();
  if (typeof data !== 'object' || data === null) return result;
  const record = data as Record<string, unknown>;
  const version = typeof record['version'] === 'number' ? record['version'] : 0;
  if (version > SETTINGS_VERSION) return result; // written by a newer build: ignore rather than misread
  // v1 is the first stored format; older/unversioned data carries nothing worth keeping.
  if (version < 1) return result;
  if (record['bindings'] !== undefined) result.bindings = parseBindings(JSON.stringify(record['bindings']));
  const controls = record['controls'];
  if (typeof controls === 'object' && controls !== null) {
    const c = controls as Record<string, unknown>;
    const d = result.controls;
    d.mouseSensitivity = clampNumber(
      c['mouseSensitivity'],
      CONTROL_LIMITS.mouseSensitivity.min,
      CONTROL_LIMITS.mouseSensitivity.max,
      d.mouseSensitivity,
    );
    d.padLookSpeed = clampNumber(
      c['padLookSpeed'],
      CONTROL_LIMITS.padLookSpeed.min,
      CONTROL_LIMITS.padLookSpeed.max,
      d.padLookSpeed,
    );
    if (typeof c['invertY'] === 'boolean') d.invertY = c['invertY'];
  }
  return result;
}

/** Player settings persisted in localStorage (falls back to in-memory when storage is unavailable). */
export class SettingsStore {
  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly key = SETTINGS_KEY,
  ) {}

  load(): GameSettings {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    if (raw === null) return defaultSettings();
    try {
      return migrateSettings(JSON.parse(raw));
    } catch {
      return defaultSettings();
    }
  }

  save(settings: GameSettings): boolean {
    try {
      this.storage?.setItem(this.key, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
      return this.storage !== null;
    } catch {
      return false;
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // Storage blocked (private mode): nothing persisted, nothing to clear.
    }
  }
}

/** localStorage if the browser allows it, else null. */
export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = globalThis.localStorage;
    const probe = '__harbor_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
