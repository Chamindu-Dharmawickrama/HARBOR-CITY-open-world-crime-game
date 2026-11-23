/** What the vehicle HUD shows (read-only view filled by the game each frame). */
export interface VehicleHudState {
  /** In a vehicle (speedometer visible). */
  driving: boolean;
  speedKmh: number;
  /** −1 reverse, 0 neutral, 1.. forward gears; null for boats (no gearbox shown). */
  gear: number | null;
  /** Engine speed 0..1 of the redline. */
  rev: number;
  /** Engine health 0..1 (shown when damaged). */
  engine: number;
  /** 0..1 while hotwiring, else null. */
  hotwire: number | null;
  /** Short prompt (e.g. "F  Enter Arbor Meridian"), or ''. */
  prompt: string;
}

/**
 * Bottom-right speedometer (speed, gear, rev bar, engine warning), a centred hotwire progress
 * bar, an interaction prompt and a vehicle-name toast. DOM writes only when values change.
 */
export class VehicleHud {
  readonly element: HTMLDivElement;
  private readonly speedo: HTMLDivElement;
  private readonly speed: HTMLSpanElement;
  private readonly gear: HTMLSpanElement;
  private readonly rev: HTMLDivElement;
  private readonly engine: HTMLDivElement;
  private readonly hotwire: HTMLDivElement;
  private readonly hotwireFill: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private readonly shown = {
    driving: false,
    speed: -1,
    gear: '',
    rev: -1,
    engine: -1,
    hotwire: -2,
    prompt: '',
  };
  private toastTimer = 0;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hc-vehicle-hud';
    this.element.dataset['testid'] = 'vehicle-hud';

    this.speedo = document.createElement('div');
    this.speedo.className = 'hc-speedo hc-hidden';
    this.speed = document.createElement('span');
    this.speed.className = 'hc-speedo-value';
    const unit = document.createElement('span');
    unit.className = 'hc-speedo-unit';
    unit.textContent = 'km/h';
    this.gear = document.createElement('span');
    this.gear.className = 'hc-speedo-gear';
    const revTrack = document.createElement('div');
    revTrack.className = 'hc-rev';
    this.rev = document.createElement('div');
    this.rev.className = 'hc-rev-fill';
    revTrack.appendChild(this.rev);
    this.engine = document.createElement('div');
    this.engine.className = 'hc-engine-warning';
    this.engine.textContent = 'ENGINE';
    this.engine.hidden = true;
    this.speedo.append(this.gear, this.speed, unit, revTrack, this.engine);

    this.hotwire = document.createElement('div');
    this.hotwire.className = 'hc-progress';
    this.hotwire.hidden = true;
    const label = document.createElement('span');
    label.textContent = 'HOTWIRING';
    const track = document.createElement('div');
    track.className = 'hc-progress-track';
    this.hotwireFill = document.createElement('div');
    this.hotwireFill.className = 'hc-progress-fill';
    track.appendChild(this.hotwireFill);
    this.hotwire.append(label, track);
    this.hotwire.dataset['testid'] = 'hotwire-bar';

    this.prompt = document.createElement('div');
    this.prompt.className = 'hc-prompt';
    this.prompt.hidden = true;
    this.toast = document.createElement('div');
    this.toast.className = 'hc-toast hc-hidden';
    this.toast.dataset['testid'] = 'vehicle-toast';

    this.element.append(this.speedo, this.hotwire, this.prompt, this.toast);
    parent.appendChild(this.element);
  }

  /** Shows the vehicle name for a few seconds (on getting in). */
  showName(name: string): void {
    this.toast.textContent = name;
    this.toast.classList.remove('hc-hidden');
    this.toastTimer = 2.6;
  }

  update(state: VehicleHudState, dt: number): void {
    const s = this.shown;
    if (state.driving !== s.driving) {
      s.driving = state.driving;
      this.speedo.classList.toggle('hc-hidden', !state.driving);
    }
    if (state.driving) {
      const speed = Math.round(state.speedKmh);
      if (speed !== s.speed) {
        s.speed = speed;
        this.speed.textContent = String(speed);
      }
      const gear =
        state.gear === null ? '' : state.gear < 0 ? 'R' : state.gear === 0 ? 'N' : String(state.gear);
      if (gear !== s.gear) {
        s.gear = gear;
        this.gear.textContent = gear;
      }
      const rev = Math.round(Math.min(1, Math.max(0, state.rev)) * 50) / 50;
      if (rev !== s.rev) {
        s.rev = rev;
        this.rev.style.width = `${rev * 100}%`;
        this.rev.classList.toggle('hc-rev-red', rev > 0.92);
      }
      const engine = Math.round(state.engine * 20) / 20;
      if (engine !== s.engine) {
        s.engine = engine;
        this.engine.hidden = engine > 0.4;
        this.engine.classList.toggle('hc-engine-critical', engine <= 0.15);
      }
    }
    const hotwire = state.hotwire === null ? -1 : Math.round(state.hotwire * 100) / 100;
    if (hotwire !== s.hotwire) {
      s.hotwire = hotwire;
      this.hotwire.hidden = hotwire < 0;
      if (hotwire >= 0) this.hotwireFill.style.width = `${hotwire * 100}%`;
    }
    if (state.prompt !== s.prompt) {
      s.prompt = state.prompt;
      this.prompt.hidden = state.prompt === '';
      this.prompt.textContent = state.prompt;
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.add('hc-hidden');
    }
  }
}
