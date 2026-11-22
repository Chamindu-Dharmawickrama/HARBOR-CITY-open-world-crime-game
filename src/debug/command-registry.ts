export interface CommandSpec {
  readonly name: string;
  readonly usage?: string;
  readonly help: string;
  /** Returns text to print (or nothing). Throw CommandError for user-facing failures. */
  run(args: readonly string[]): string | void;
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

/** Error whose message is shown to the console user as-is. */
export class CommandError extends Error {}

/** Splits a command line on whitespace, honouring "double" and 'single' quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) throw new CommandError('Unterminated quote');
  if (hasToken) tokens.push(current);
  return tokens;
}

export function numberArg(args: readonly string[], index: number, label: string, fallback?: number): number {
  const raw = args[index];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CommandError(`Missing ${label}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CommandError(`${label} must be a number, got "${raw}"`);
  return value;
}

export function toggleArg(args: readonly string[], index: number, current: boolean): boolean {
  const raw = args[index]?.toLowerCase();
  if (raw === undefined) return !current;
  if (['on', '1', 'true', 'yes'].includes(raw)) return true;
  if (['off', '0', 'false', 'no'].includes(raw)) return false;
  throw new CommandError(`Expected on/off, got "${raw}"`);
}

/** Named developer commands shared by the dev console and the test API. */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandSpec>();

  register(spec: CommandSpec): void {
    const name = spec.name.toLowerCase();
    if (this.commands.has(name)) throw new Error(`Command "${name}" already registered`);
    this.commands.set(name, spec);
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  list(): CommandSpec[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  execute(line: string): CommandResult {
    let tokens: string[];
    try {
      tokens = tokenize(line.trim());
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
    const [head, ...args] = tokens;
    if (head === undefined) return { ok: true, output: '' };
    const spec = this.commands.get(head.toLowerCase());
    if (!spec) {
      const close = this.list()
        .map((c) => c.name)
        .filter((n) => n.startsWith(head.slice(0, 2).toLowerCase()));
      const hint = close.length > 0 ? ` Did you mean: ${close.join(', ')}?` : ' Type "help".';
      return { ok: false, output: `Unknown command "${head}".${hint}` };
    }
    try {
      return { ok: true, output: spec.run(args) ?? '' };
    } catch (error) {
      if (error instanceof CommandError) return { ok: false, output: error.message };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `Command "${spec.name}" failed: ${message}` };
    }
  }

  helpText(): string {
    return this.list()
      .map((c) => `${(c.usage ?? c.name).padEnd(28)} ${c.help}`)
      .join('\n');
  }
}
