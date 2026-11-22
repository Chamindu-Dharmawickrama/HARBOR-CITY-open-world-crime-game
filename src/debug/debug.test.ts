import { describe, expect, it } from 'vitest';
import { CommandError, CommandRegistry, numberArg, toggleArg, tokenize } from './command-registry';
import { ProbeRegistry } from './probe-registry';

describe('tokenize', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize('spawn  10')).toEqual(['spawn', '10']);
    expect(tokenize('say "hello world" \'x y\'')).toEqual(['say', 'hello world', 'x y']);
    expect(tokenize('empty ""')).toEqual(['empty', '']);
    expect(tokenize('   ')).toEqual([]);
    expect(() => tokenize('bad "quote')).toThrow(CommandError);
  });
});

describe('argument helpers', () => {
  it('numberArg parses, defaults and rejects', () => {
    expect(numberArg(['5'], 0, 'n')).toBe(5);
    expect(numberArg([], 0, 'n', 3)).toBe(3);
    expect(() => numberArg([], 0, 'n')).toThrow(/Missing n/);
    expect(() => numberArg(['abc'], 0, 'n')).toThrow(/must be a number/);
  });

  it('toggleArg flips or parses', () => {
    expect(toggleArg([], 0, true)).toBe(false);
    expect(toggleArg(['on'], 0, false)).toBe(true);
    expect(toggleArg(['OFF'], 0, true)).toBe(false);
    expect(() => toggleArg(['maybe'], 0, true)).toThrow();
  });
});

describe('CommandRegistry', () => {
  it('executes commands case-insensitively with args', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'Echo', help: 'echo', run: (args) => args.join(' ') });
    expect(registry.execute('ECHO a b')).toEqual({ ok: true, output: 'a b' });
    expect(registry.has('echo')).toBe(true);
    expect(registry.execute('')).toEqual({ ok: true, output: '' });
  });

  it('reports unknown commands with suggestions', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'spawn', help: '', run: () => 'ok' });
    const result = registry.execute('spwan');
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/spawn/);
  });

  it('turns thrown errors into failed results', () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'fail',
      help: '',
      run: () => {
        throw new CommandError('nope');
      },
    });
    registry.register({
      name: 'crash',
      help: '',
      run: () => {
        throw new Error('bug');
      },
    });
    expect(registry.execute('fail')).toEqual({ ok: false, output: 'nope' });
    expect(registry.execute('crash').output).toMatch(/failed: bug/);
  });

  it('rejects duplicate names and lists help', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'b', help: 'second', run: () => undefined });
    registry.register({ name: 'a', usage: 'a <x>', help: 'first', run: () => undefined });
    expect(() => registry.register({ name: 'A', help: '', run: () => undefined })).toThrow();
    expect(registry.helpText().split('\n')[0]).toMatch(/^a <x>\s+first$/);
  });
});

describe('ProbeRegistry', () => {
  it('reads named probes and lists them', () => {
    const probes = new ProbeRegistry();
    let value = 1;
    probes.register('counter', () => ({ value }));
    value = 2;
    expect(probes.read('counter')).toEqual({ value: 2 });
    expect(probes.names()).toEqual(['counter']);
    expect(() => probes.read('missing')).toThrow(/Unknown probe/);
    expect(() => probes.register('counter', () => 0)).toThrow();
  });
});
