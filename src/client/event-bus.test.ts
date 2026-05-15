import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event-bus';

type TestMap = {
  num: number;
  tick: void;
  obj: { id: number };
};

describe('EventBus', () => {
  it('delivers payloads to subscribers of the matching event', () => {
    const bus = new EventBus<TestMap>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('num', a);
    bus.on('obj', b);
    bus.emit('num', 42);
    expect(a).toHaveBeenCalledWith(42);
    expect(b).not.toHaveBeenCalled();
    bus.emit('obj', { id: 7 });
    expect(b).toHaveBeenCalledWith({ id: 7 });
  });

  it('supports payload-less events', () => {
    const bus = new EventBus<TestMap>();
    const fn = vi.fn();
    bus.on('tick', fn);
    bus.emit('tick');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe that detaches the handler', () => {
    const bus = new EventBus<TestMap>();
    const fn = vi.fn();
    const off = bus.on('num', fn);
    bus.emit('num', 1);
    off();
    bus.emit('num', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('dedupes identical handler references on register', () => {
    const bus = new EventBus<TestMap>();
    const fn = vi.fn();
    bus.on('num', fn);
    bus.on('num', fn);
    bus.emit('num', 9);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op to emit an event with no subscribers', () => {
    const bus = new EventBus<TestMap>();
    expect(() => bus.emit('num', 1)).not.toThrow();
  });

  it('clear() detaches every subscriber across every event', () => {
    const bus = new EventBus<TestMap>();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    bus.on('num', a);
    bus.on('tick', b);
    bus.on('obj', c);
    bus.clear();
    bus.emit('num', 1);
    bus.emit('tick');
    bus.emit('obj', { id: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
  });

  it('skips a handler removed mid-emit', () => {
    const bus = new EventBus<TestMap>();
    const seen: string[] = [];
    const offB = { fn: () => {} };
    bus.on('num', () => {
      seen.push('a');
      offB.fn();
    });
    offB.fn = bus.on('num', () => {
      seen.push('b');
    });
    bus.emit('num', 0);
    expect(seen).toEqual(['a']);
  });
});
