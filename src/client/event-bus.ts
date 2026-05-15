// Generic typed pub/sub. `M` is an event-name → payload-type map; the
// compiler enforces handler/payload alignment per event. `on()` returns an
// unsubscribe — Set-backed registration dedupes identical handlers and
// makes mid-emit unsubscribe well-defined (the removed handler is skipped
// if not yet visited).

type EmitArgs<M, K extends keyof M> = M[K] extends void
  ? [name: K]
  : [name: K, payload: M[K]];

export class EventBus<M extends Record<string, unknown>> {
  private handlers = new Map<keyof M, Set<(payload: never) => void>>();

  on<K extends keyof M>(name: K, handler: (payload: M[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const slot = set;
    slot.add(handler as (payload: never) => void);
    return () => {
      slot.delete(handler as (payload: never) => void);
    };
  }

  emit<K extends keyof M>(...args: EmitArgs<M, K>): void {
    const name = args[0];
    const payload = (args.length > 1 ? args[1] : undefined) as M[K];
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) (h as (p: M[K]) => void)(payload);
  }

  // Detach every subscriber across every event. Called from
  // `Stellata.dispose()` so HMR teardown can release the closures that
  // would otherwise pin the previous Stellata instance through this bus.
  clear(): void {
    this.handlers.clear();
  }
}
