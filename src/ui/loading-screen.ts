/** Full-screen title card shown while the engine boots. */
export class LoadingScreen {
  readonly element: HTMLDivElement;
  private readonly status: HTMLParagraphElement;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hc-loading';
    this.element.dataset['testid'] = 'loading-screen';
    const title = document.createElement('h1');
    title.textContent = 'HARBOR CITY';
    this.status = document.createElement('p');
    this.status.className = 'hc-loading-status';
    this.status.setAttribute('role', 'status');
    this.element.append(title, this.status);
    parent.appendChild(this.element);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  hide(): void {
    this.element.classList.add('hc-hidden');
    window.setTimeout(() => this.element.remove(), 400);
  }
}
