import { isAxisAction } from '../../core/input/actions';
import { describeBinding, type Binding, type BindingMap } from '../../core/input/bindings';
import { CONTROL_LIMITS, type ControlSettings } from '../../save/settings-store';
import {
  assignSlot,
  clearSlot,
  CONTROL_ROWS,
  rowSlots,
  SLOTS_PER_DEVICE,
  type CapturedControl,
  type ControlRow,
  type SlotDevice,
} from './control-rows';

/** What the panel edits; the game applies changes to the input system and persists them. */
export interface ControlsModel {
  getBindings(): BindingMap;
  setBindings(map: BindingMap): void;
  getControls(): ControlSettings;
  setControls(controls: ControlSettings): void;
  resetDefaults(): void;
}

interface Listening {
  row: ControlRow;
  device: SlotDevice;
  ordinal: number;
  button: HTMLButtonElement;
  padBaseline: { buttons: number[]; axes: number[] } | null;
  raf: number;
}

const AXIS_CAPTURE = 0.6;

/**
 * Rebinding table (two keyboard/mouse slots and one gamepad slot per action), mouse sensitivity,
 * stick look speed and invert-Y. Click a slot, then press a key / mouse button / pad control;
 * Esc cancels, Backspace or Delete clears the slot.
 */
export class ControlsPanel {
  readonly element: HTMLDivElement;
  private readonly table: HTMLTableSectionElement;
  private readonly sensitivity: HTMLInputElement;
  private readonly padSpeed: HTMLInputElement;
  private readonly invert: HTMLInputElement;
  private listening: Listening | null = null;

  constructor(private readonly model: ControlsModel) {
    this.element = document.createElement('div');
    this.element.className = 'hc-controls';
    this.element.dataset['testid'] = 'controls-panel';

    const options = document.createElement('div');
    options.className = 'hc-controls-options';
    this.sensitivity = this.slider(options, 'Mouse sensitivity', CONTROL_LIMITS.mouseSensitivity, (v) => {
      this.model.setControls({ ...this.model.getControls(), mouseSensitivity: v });
    });
    this.padSpeed = this.slider(options, 'Stick look speed', CONTROL_LIMITS.padLookSpeed, (v) => {
      this.model.setControls({ ...this.model.getControls(), padLookSpeed: v });
    });
    const invertLabel = document.createElement('label');
    invertLabel.className = 'hc-check';
    this.invert = document.createElement('input');
    this.invert.type = 'checkbox';
    this.invert.addEventListener('change', () => {
      this.model.setControls({ ...this.model.getControls(), invertY: this.invert.checked });
    });
    invertLabel.append(this.invert, ' Invert look up/down');
    options.appendChild(invertLabel);

    const tableEl = document.createElement('table');
    tableEl.className = 'hc-bindings';
    const head = tableEl.createTHead().insertRow();
    for (const text of ['Action', 'Keyboard / mouse', '', 'Gamepad']) {
      const th = document.createElement('th');
      th.textContent = text;
      head.appendChild(th);
    }
    this.table = tableEl.createTBody();

    const footer = document.createElement('div');
    footer.className = 'hc-controls-footer';
    const hint = document.createElement('span');
    hint.textContent = 'Click a slot, then press a control · Esc cancels · Backspace clears';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'hc-button hc-button-small';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      this.cancelListening();
      this.model.resetDefaults();
      this.refresh();
    });
    footer.append(hint, reset);

    const scroller = document.createElement('div');
    scroller.className = 'hc-bindings-scroll';
    scroller.appendChild(tableEl);
    this.element.append(options, scroller, footer);
    this.refresh();
  }

  get isListening(): boolean {
    return this.listening !== null;
  }

  /** Re-renders all rows and option values from the model. */
  refresh(): void {
    const map = this.model.getBindings();
    const controls = this.model.getControls();
    this.sensitivity.value = String(controls.mouseSensitivity);
    this.padSpeed.value = String(controls.padLookSpeed);
    this.invert.checked = controls.invertY;
    this.table.replaceChildren();
    for (const row of CONTROL_ROWS) {
      const tr = this.table.insertRow();
      if (row.debug) tr.className = 'hc-row-debug';
      const name = tr.insertCell();
      name.textContent = row.label;
      for (const device of ['kbm', 'pad'] as const) {
        const slots = rowSlots(map, row, device);
        for (let ordinal = 0; ordinal < SLOTS_PER_DEVICE[device]; ordinal++) {
          const cell = tr.insertCell();
          if (device === 'kbm' && row.padOnly) {
            cell.textContent = ordinal === 0 ? 'mouse' : '';
            cell.className = 'hc-slot-fixed';
            continue;
          }
          const index = slots[ordinal];
          const binding = index === undefined ? undefined : map[row.action][index];
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'hc-slot';
          button.textContent = binding ? labelFor(row, binding) : '—';
          button.dataset['action'] = row.action;
          button.dataset['sign'] = String(row.sign);
          button.dataset['device'] = device;
          button.dataset['ordinal'] = String(ordinal);
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            this.startListening(row, device, ordinal, button);
          });
          cell.appendChild(button);
        }
      }
    }
  }

  /** Stops any capture in progress (when the menu closes). */
  cancelListening(): void {
    const l = this.listening;
    if (!l) return;
    this.listening = null;
    cancelAnimationFrame(l.raf);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('mousedown', this.onMouseDown, true);
    l.button.classList.remove('hc-slot-listening');
    this.refresh();
  }

  private slider(
    parent: HTMLElement,
    label: string,
    limits: { min: number; max: number; step: number },
    onChange: (value: number) => void,
  ): HTMLInputElement {
    const wrap = document.createElement('label');
    wrap.className = 'hc-slider';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.step = String(limits.step);
    input.addEventListener('input', () => onChange(Number(input.value)));
    wrap.append(text, input);
    parent.appendChild(wrap);
    return input;
  }

  private startListening(
    row: ControlRow,
    device: SlotDevice,
    ordinal: number,
    button: HTMLButtonElement,
  ): void {
    this.cancelListening();
    const fresh = this.findSlotButton(row, device, ordinal) ?? button;
    fresh.textContent = 'press…';
    fresh.classList.add('hc-slot-listening');
    const listening: Listening = { row, device, ordinal, button: fresh, padBaseline: null, raf: 0 };
    this.listening = listening;
    window.addEventListener('keydown', this.onKeyDown, true);
    if (device === 'kbm') window.addEventListener('mousedown', this.onMouseDown, true);
    else {
      listening.padBaseline = readPad();
      const poll = (): void => {
        if (this.listening !== listening) return;
        const captured = this.detectPad(listening);
        if (captured) this.assign(captured);
        else listening.raf = requestAnimationFrame(poll);
      };
      listening.raf = requestAnimationFrame(poll);
    }
  }

  private findSlotButton(row: ControlRow, device: SlotDevice, ordinal: number): HTMLButtonElement | null {
    return this.table.querySelector<HTMLButtonElement>(
      `button[data-action="${row.action}"][data-sign="${row.sign}"][data-device="${device}"][data-ordinal="${ordinal}"]`,
    );
  }

  private assign(control: CapturedControl): void {
    const l = this.listening;
    if (!l) return;
    this.model.setBindings(assignSlot(this.model.getBindings(), l.row, l.device, l.ordinal, control));
    this.cancelListening();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const l = this.listening;
    if (!l) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') {
      this.cancelListening();
      return;
    }
    if (event.code === 'Backspace' || event.code === 'Delete') {
      this.model.setBindings(clearSlot(this.model.getBindings(), l.row, l.device, l.ordinal));
      this.cancelListening();
      return;
    }
    if (l.device === 'kbm') this.assign({ kind: 'key', code: event.code });
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.listening) return;
    event.preventDefault();
    event.stopPropagation();
    this.assign({ kind: 'mouseButton', button: event.button });
  };

  private detectPad(l: Listening): CapturedControl | null {
    const now = readPad();
    const base = l.padBaseline;
    if (!now || !base) return null;
    for (let i = 0; i < now.buttons.length; i++) {
      if (now.buttons[i] > 0.6 && (base.buttons[i] ?? 0) <= 0.6) return { kind: 'padButton', index: i };
    }
    for (let i = 0; i < Math.min(4, now.axes.length); i++) {
      const v = now.axes[i];
      if (Math.abs(v) > AXIS_CAPTURE && Math.abs(base.axes[i] ?? 0) < AXIS_CAPTURE) {
        return { kind: 'padAxis', index: i, direction: v > 0 ? 1 : -1 };
      }
    }
    // Keep the baseline fresh for controls that were held when capture began.
    l.padBaseline = now;
    return null;
  }
}

/** A stick axis on an axis action covers both rows: show the direction this row uses. */
function labelFor(row: ControlRow, binding: Binding): string {
  if (binding.kind === 'padAxis' && isAxisAction(row.action)) {
    return describeBinding({ ...binding, scale: row.sign * Math.sign(binding.scale) });
  }
  return describeBinding(binding);
}

function readPad(): { buttons: number[]; axes: number[] } | null {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (pad?.connected) return { buttons: pad.buttons.map((b) => b.value), axes: [...pad.axes] };
  }
  return { buttons: [], axes: [] };
}
