import { RawInputState, type InputSource } from './raw-input';

/**
 * Scriptable input device. Automated tests and benchmarks drive the game through this device;
 * it feeds the same raw state as a physical keyboard/mouse/gamepad, so everything above the
 * binding layer runs exactly as it does for a player.
 */
export class VirtualInputDevice implements InputSource {
  readonly id = 'virtual';
  readonly kind = 'virtual' as const;
  readonly raw = new RawInputState();

  keyDown(code: string): void {
    this.raw.pressKey(code);
  }

  keyUp(code: string): void {
    this.raw.releaseKey(code);
  }

  mouseButton(button: number, down: boolean): void {
    if (down) this.raw.pressMouse(button);
    else this.raw.releaseMouse(button);
  }

  mouseMove(dx: number, dy: number): void {
    this.raw.moveMouse(dx, dy);
  }

  padAxis(index: number, value: number): void {
    this.raw.setPadAxis(index, value);
  }

  padButton(index: number, value: number): void {
    this.raw.setPadButton(index, value);
  }

  releaseAll(): void {
    this.raw.releaseAll();
  }
}
