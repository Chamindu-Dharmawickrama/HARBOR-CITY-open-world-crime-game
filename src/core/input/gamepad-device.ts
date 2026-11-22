import { PAD_AXIS_COUNT, PAD_BUTTON_COUNT, RawInputState, type InputSource } from './raw-input';

/** First connected gamepad, read through the standard mapping. Polled once per frame. */
export class GamepadDevice implements InputSource {
  readonly id = 'gamepad';
  readonly kind = 'gamepad' as const;
  readonly raw = new RawInputState();
  name = '';

  constructor(private readonly nav: Navigator = navigator) {}

  poll(): void {
    const pads = typeof this.nav.getGamepads === 'function' ? this.nav.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate?.connected) {
        pad = candidate;
        break;
      }
    }
    const raw = this.raw;
    if (!pad) {
      if (raw.padConnected) {
        raw.releaseAll();
        raw.padConnected = false;
        this.name = '';
      }
      return;
    }
    raw.padConnected = true;
    this.name = pad.id;
    const axisCount = Math.min(pad.axes.length, PAD_AXIS_COUNT);
    for (let i = 0; i < axisCount; i++) raw.setPadAxis(i, pad.axes[i] ?? 0);
    const buttonCount = Math.min(pad.buttons.length, PAD_BUTTON_COUNT);
    for (let i = 0; i < buttonCount; i++) {
      const button = pad.buttons[i];
      raw.setPadButton(i, button ? Math.max(button.value, button.pressed ? 1 : 0) : 0);
    }
  }
}
