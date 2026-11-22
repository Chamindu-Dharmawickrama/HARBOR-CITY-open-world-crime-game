import { ControlsPanel, type ControlsModel } from './controls-panel';

export interface PauseMenuActions {
  resume(): void;
  respawn(): void;
}

type Page = 'main' | 'controls';

/**
 * Pause menu: Resume, Controls (rebinding + sensitivity), Respawn. Opened by the pause action or
 * when pointer lock is lost; the pause action again goes back a page or resumes.
 */
export class PauseMenu {
  readonly element: HTMLDivElement;
  readonly controls: ControlsPanel;
  private readonly mainPage: HTMLDivElement;
  private readonly controlsPage: HTMLDivElement;
  private open = false;
  private page: Page = 'main';

  constructor(
    parent: HTMLElement,
    model: ControlsModel,
    private readonly actions: PauseMenuActions,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hc-menu';
    this.element.dataset['testid'] = 'pause-menu';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Pause menu');

    const panel = document.createElement('div');
    panel.className = 'hc-menu-panel';
    const title = document.createElement('h2');
    title.textContent = 'PAUSED';

    this.mainPage = document.createElement('div');
    this.mainPage.className = 'hc-menu-page';
    this.mainPage.append(
      this.button('Resume', 'menu-resume', () => this.actions.resume()),
      this.button('Controls', 'menu-controls', () => this.show('controls')),
      this.button('Respawn', 'menu-respawn', () => {
        this.actions.respawn();
        this.actions.resume();
      }),
    );

    this.controls = new ControlsPanel(model);
    this.controlsPage = document.createElement('div');
    this.controlsPage.className = 'hc-menu-page hc-menu-page-wide';
    this.controlsPage.append(
      this.controls.element,
      this.button('Back', 'menu-back', () => this.show('main')),
    );

    panel.append(title, this.mainPage, this.controlsPage);
    this.element.appendChild(panel);
    parent.appendChild(this.element);
    this.show('main');
  }

  get isOpen(): boolean {
    return this.open;
  }

  get currentPage(): Page {
    return this.page;
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.element.hidden = !open;
    if (open) this.show('main');
    else this.controls.cancelListening();
  }

  show(page: Page): void {
    this.page = page;
    this.mainPage.hidden = page !== 'main';
    this.controlsPage.hidden = page !== 'controls';
    if (page === 'controls') this.controls.refresh();
    else this.controls.cancelListening();
  }

  private button(label: string, testId: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hc-button';
    button.textContent = label;
    button.dataset['testid'] = testId;
    button.addEventListener('click', onClick);
    return button;
  }

  /** The pause action while open: back from a sub-page, else resume. Ignored while rebinding. */
  handlePauseAction(): void {
    if (!this.open || this.controls.isListening) return;
    if (this.page === 'controls') this.show('main');
    else this.actions.resume();
  }
}
