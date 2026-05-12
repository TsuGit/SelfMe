import { EventEmitter } from "node:events";

import type { RuntimeEvent } from "../types/events.js";

export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: RuntimeEvent) {
    this.emitter.emit(event.type, event);
    this.emitter.emit("*", event);
  }

  on<T extends RuntimeEvent["type"]>(
    type: T,
    listener: (event: Extract<RuntimeEvent, { type: T }>) => void
  ) {
    this.emitter.on(type, listener as (event: RuntimeEvent) => void);
    return () => {
      this.emitter.off(type, listener as (event: RuntimeEvent) => void);
    };
  }

  onAny(listener: (event: RuntimeEvent) => void) {
    this.emitter.on("*", listener);
    return () => {
      this.emitter.off("*", listener);
    };
  }
}

