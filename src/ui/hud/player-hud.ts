/** Values the vitals HUD shows (a narrow read-only view of the player's state). */
export interface VitalsSource {
  readonly health: number;
  readonly maxHealth: number;
  readonly armor: number;
  readonly maxArmor: number;
  readonly stamina: number;
  readonly maxStamina: number;
  readonly exhausted: boolean;
}

function bar(className: string, label: string): { root: HTMLDivElement; fill: HTMLDivElement } {
  const root = document.createElement('div');
  root.className = `hc-bar ${className}`;
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', label);
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'hc-bar-fill';
  root.appendChild(fill);
  return { root, fill };
}

/**
 * Health / armour / stamina bars (top right). The DOM is touched only when a displayed value
 * changes by at least half a percent, so a steady state costs nothing per frame.
 */
export class PlayerHud {
  readonly element: HTMLDivElement;
  private readonly health = bar('hc-bar-health', 'Health');
  private readonly armor = bar('hc-bar-armor', 'Armour');
  private readonly stamina = bar('hc-bar-stamina', 'Stamina');
  private shown = [-1, -1, -1];
  private exhausted = false;
  private staminaVisible = false;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hc-hud-vitals';
    this.element.dataset['testid'] = 'hud-vitals';
    this.element.append(this.health.root, this.armor.root, this.stamina.root);
    parent.appendChild(this.element);
    this.stamina.root.classList.add('hc-hidden');
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  update(v: VitalsSource): void {
    this.set(0, this.health, v.maxHealth > 0 ? v.health / v.maxHealth : 0);
    this.set(1, this.armor, v.maxArmor > 0 ? v.armor / v.maxArmor : 0);
    this.set(2, this.stamina, v.maxStamina > 0 ? v.stamina / v.maxStamina : 0);
    this.armor.root.hidden = v.armor <= 0;
    const staminaVisible = v.stamina < v.maxStamina - 0.5;
    if (staminaVisible !== this.staminaVisible) {
      this.staminaVisible = staminaVisible;
      this.stamina.root.classList.toggle('hc-hidden', !staminaVisible);
    }
    if (v.exhausted !== this.exhausted) {
      this.exhausted = v.exhausted;
      this.stamina.root.classList.toggle('hc-bar-exhausted', v.exhausted);
    }
  }

  private set(slot: number, target: { root: HTMLDivElement; fill: HTMLDivElement }, fraction: number): void {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 200) / 2;
    if (percent === this.shown[slot]) return;
    this.shown[slot] = percent;
    target.fill.style.width = `${percent}%`;
    target.root.setAttribute('aria-valuenow', String(Math.round(percent)));
    if (slot === 0) target.root.classList.toggle('hc-bar-low', percent <= 25);
  }
}
