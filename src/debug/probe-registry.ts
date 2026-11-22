/**
 * Named read-only views of game state (JSON-serialisable). Systems register probes; the test
 * API and the dev console read them. Probes must never mutate state.
 */
export class ProbeRegistry {
  private readonly probes = new Map<string, () => unknown>();

  register(name: string, read: () => unknown): void {
    if (this.probes.has(name)) throw new Error(`Probe "${name}" already registered`);
    this.probes.set(name, read);
  }

  read(name: string): unknown {
    const probe = this.probes.get(name);
    if (!probe) throw new Error(`Unknown probe "${name}". Known: ${this.names().join(', ')}`);
    return probe();
  }

  names(): string[] {
    return [...this.probes.keys()].sort();
  }
}
