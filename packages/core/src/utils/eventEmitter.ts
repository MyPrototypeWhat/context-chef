export type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Minimal, type-safe event emitter for internal use.
 * Supports sync and async handlers. Handlers are invoked sequentially in registration order.
 *
 * Implementation note: The listener map stores `EventHandler<never>` so specific
 * handler types (`EventHandler<Events[K]>`) can be added via contravariant
 * assignment without a cast. `never` is assignable to any type, so a handler
 * that accepts `Events[K]` also accepts `never` in its parameter position.
 * The only unavoidable cast is in `emit()`, where we must widen back to the
 * specific type to actually call the handler with a concrete payload.
 */
export class TypedEventEmitter<Events extends { [K in keyof Events]: unknown }> {
  private listeners = new Map<keyof Events, Set<EventHandler<never>>>();

  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      // Unavoidable cast: handlers are stored as EventHandler<never> so we can
      // put specific types into the set, but to call them with a real payload
      // we need to widen back to the specific event type. Runtime is safe
      // because on() only ever adds handlers matching their event's type.
      await (handler as EventHandler<Events[K]>)(payload);
    }
  }
}
