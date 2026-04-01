export type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Minimal, type-safe event emitter for internal use.
 * Supports sync and async handlers. Handlers are invoked sequentially in registration order.
 */
export class TypedEventEmitter<Events extends { [K in keyof Events]: unknown }> {
  private listeners = new Map<keyof Events, Set<EventHandler<never>>>();

  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler<never>);
    return this;
  }

  off<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): this {
    this.listeners.get(event)?.delete(handler as EventHandler<never>);
    return this;
  }

  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      await (handler as EventHandler<Events[K]>)(payload);
    }
  }
}
