import type { CommandRegistry } from './command-registry';

const TOGGLE_KEY = 'Backquote';
const MAX_LINES = 200;

/** In-game developer console (backtick). Runs commands from the shared registry. */
export class DevConsole {
  readonly element: HTMLDivElement;
  private readonly log: HTMLPreElement;
  private readonly input: HTMLInputElement;
  private readonly history: string[] = [];
  private historyIndex = -1;
  private openFlag = false;
  private readonly lines: string[] = [];

  constructor(
    parent: HTMLElement,
    private readonly commands: CommandRegistry,
    private readonly onOpenChange: (open: boolean) => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'hc-console';
    this.element.hidden = true;
    this.log = document.createElement('pre');
    this.log.className = 'hc-console-log';
    this.input = document.createElement('input');
    this.input.className = 'hc-console-input';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-label', 'Developer console command');
    this.input.dataset['testid'] = 'console-input';
    this.element.append(this.log, this.input);
    parent.appendChild(this.element);
    this.print('Harbor City developer console. Type "help" for commands.');
    window.addEventListener('keydown', this.onGlobalKeyDown, true);
    this.input.addEventListener('keydown', this.onInputKeyDown);
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  setOpen(open: boolean): void {
    if (open === this.openFlag) return;
    this.openFlag = open;
    this.element.hidden = !open;
    if (open) {
      this.input.value = '';
      this.input.focus();
    } else {
      this.input.blur();
    }
    this.onOpenChange(open);
  }

  print(text: string): void {
    for (const line of text.split('\n')) this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.log.textContent = this.lines.join('\n');
    this.log.scrollTop = this.log.scrollHeight;
  }

  clear(): void {
    this.lines.length = 0;
    this.log.textContent = '';
  }

  submit(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    this.history.unshift(trimmed);
    this.historyIndex = -1;
    this.print(`> ${trimmed}`);
    const result = this.commands.execute(trimmed);
    if (result.output) this.print(result.ok ? result.output : `! ${result.output}`);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onGlobalKeyDown, true);
    this.element.remove();
  }

  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== TOGGLE_KEY) return;
    event.preventDefault();
    event.stopPropagation();
    this.setOpen(!this.openFlag);
  };

  private readonly onInputKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Enter') {
      this.submit(this.input.value);
      this.input.value = '';
    } else if (event.code === 'Escape') {
      this.setOpen(false);
    } else if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
      if (this.history.length === 0) return;
      const delta = event.code === 'ArrowUp' ? 1 : -1;
      this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + delta));
      this.input.value = this.historyIndex >= 0 ? (this.history[this.historyIndex] ?? '') : '';
    }
    event.stopPropagation();
  };
}
