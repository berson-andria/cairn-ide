import { Injectable } from '@angular/core';

export type CommandHandler = (args?: unknown) => unknown | Promise<unknown>;

/**
 * Commands are the things the app can DO, named by id ("file.save").
 * Keyboard shortcuts, menus and buttons all go through `execute`, so adding another way
 * to trigger something never means duplicating its logic.
 */
@Injectable({ providedIn: 'root' })
export class CommandService {
  private readonly handlers = new Map<string, CommandHandler>();

  /** Returns a function that unregisters the command. */
  register(id: string, handler: CommandHandler): () => void {
    if (this.handlers.has(id)) console.warn(`Command '${id}' registered twice; the last one wins.`);
    this.handlers.set(id, handler);
    return () => {
      if (this.handlers.get(id) === handler) this.handlers.delete(id);
    };
  }

  has(id: string): boolean {
    return this.handlers.has(id);
  }

  async execute(id: string, args?: unknown): Promise<void> {
    const handler = this.handlers.get(id);
    if (!handler) {
      console.warn(`No handler registered for command '${id}'.`);
      return;
    }
    try {
      await handler(args);
    } catch (err) {
      console.error(`Command '${id}' failed`, err);
    }
  }
}
