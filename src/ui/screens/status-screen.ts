/**
 * Full-screen status card (FLATLINED on death; CUFFED on arrest from M6): fades in over the
 * game with a title and a one-line subtitle.
 */
export class StatusScreen {
  readonly element: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly subtitle: HTMLParagraphElement;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hc-status hc-hidden';
    this.element.dataset['testid'] = 'status-screen';
    this.element.setAttribute('aria-live', 'assertive');
    this.title = document.createElement('h2');
    this.subtitle = document.createElement('p');
    this.element.append(this.title, this.subtitle);
    parent.appendChild(this.element);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get text(): string {
    return this.visible ? (this.title.textContent ?? '') : '';
  }

  show(title: string, subtitle: string, tone: 'death' | 'arrest' = 'death'): void {
    this.title.textContent = title;
    this.subtitle.textContent = subtitle;
    this.element.dataset['tone'] = tone;
    this.element.classList.remove('hc-hidden');
    this.visible = true;
  }

  hide(): void {
    this.element.classList.add('hc-hidden');
    this.visible = false;
  }
}
