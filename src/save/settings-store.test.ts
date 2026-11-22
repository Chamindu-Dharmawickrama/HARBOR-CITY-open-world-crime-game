import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, rebind } from '../core/input/bindings';
import {
  CONTROL_LIMITS,
  defaultSettings,
  migrateSettings,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsStore,
  type KeyValueStorage,
} from './settings-store';

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('SettingsStore', () => {
  it('returns defaults when nothing is stored', () => {
    expect(new SettingsStore(new MemoryStorage()).load()).toEqual(defaultSettings());
    expect(new SettingsStore(null).load()).toEqual(defaultSettings());
  });

  it('round-trips bindings and control settings with a version tag', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore(storage);
    const settings = defaultSettings();
    settings.bindings = rebind(DEFAULT_BINDINGS, 'jump', 0, { kind: 'key', code: 'KeyF', scale: 1 });
    settings.controls = { mouseSensitivity: 0.003, invertY: true, padLookSpeed: 4.5 };
    expect(store.save(settings)).toBe(true);
    const raw = JSON.parse(storage.data.get(SETTINGS_KEY) ?? '{}') as { version: number };
    expect(raw.version).toBe(SETTINGS_VERSION);
    const loaded = store.load();
    expect(loaded.bindings.jump[0]).toEqual({ kind: 'key', code: 'KeyF', scale: 1 });
    expect(loaded.controls).toEqual(settings.controls);
  });

  it('survives corrupt JSON, unknown versions and storage that throws', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, '{not json');
    expect(new SettingsStore(storage).load()).toEqual(defaultSettings());
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION + 1, controls: { invertY: true } }),
    );
    expect(new SettingsStore(storage).load().controls.invertY).toBe(false);
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = new SettingsStore(throwing);
    expect(store.load()).toEqual(defaultSettings());
    expect(store.save(defaultSettings())).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });

  it('clamps out-of-range values and ignores wrong types', () => {
    const s = migrateSettings({
      version: 1,
      controls: { mouseSensitivity: 99, padLookSpeed: -3, invertY: 'yes' },
      bindings: {
        jump: [
          { kind: 'key', code: '', scale: 1 },
          { kind: 'key', code: 'KeyJ', scale: 1 },
        ],
      },
    });
    expect(s.controls.mouseSensitivity).toBe(CONTROL_LIMITS.mouseSensitivity.max);
    expect(s.controls.padLookSpeed).toBe(CONTROL_LIMITS.padLookSpeed.min);
    expect(s.controls.invertY).toBe(false);
    expect(s.bindings.jump).toEqual([{ kind: 'key', code: 'KeyJ', scale: 1 }]);
    // Actions missing from stored data (added in later versions) get their defaults.
    expect(s.bindings.walk).toEqual(DEFAULT_BINDINGS.walk);
  });

  it('treats unversioned legacy data as defaults', () => {
    expect(migrateSettings({ controls: { invertY: true } })).toEqual(defaultSettings());
  });
});
