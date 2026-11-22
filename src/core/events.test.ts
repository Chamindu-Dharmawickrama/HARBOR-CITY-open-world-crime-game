import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './events';

interface TestEvents {
  'test:a': { value: number };
  'test:b': { text: string };
}

describe('EventBus', () => {
  it('queues emits until flush', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on('test:a', handler);
    bus.emit('test:a', { value: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(bus.pending).toBe(1);
    expect(bus.flush()).toBe(1);
    expect(handler).toHaveBeenCalledWith({ value: 1 });
    expect(bus.pending).toBe(0);
  });

  it('emitNow dispatches synchronously', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on('test:b', handler);
    bus.emitNow('test:b', { text: 'hi' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('preserves order and processes events raised during flush', () => {
    const bus = new EventBus<TestEvents>();
    const order: string[] = [];
    bus.on('test:a', ({ value }) => {
      order.push(`a${value}`);
      if (value === 1) bus.emit('test:b', { text: 'chained' });
    });
    bus.on('test:b', ({ text }) => order.push(text));
    bus.emit('test:a', { value: 1 });
    bus.emit('test:a', { value: 2 });
    bus.flush();
    expect(order).toEqual(['a1', 'a2', 'chained']);
  });

  it('unsubscribe works, including during dispatch', () => {
    const bus = new EventBus<TestEvents>();
    const second = vi.fn();
    const off = bus.on('test:a', () => off());
    bus.on('test:a', second);
    bus.emitNow('test:a', { value: 1 });
    bus.emitNow('test:a', { value: 2 });
    expect(second).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount('test:a')).toBe(1);
  });

  it('detects handler feedback loops', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('test:a', (p) => bus.emit('test:a', p));
    bus.emit('test:a', { value: 0 });
    expect(() => bus.flush(100)).toThrow(/feedback loop/);
    expect(bus.pending).toBe(0);
  });
});
