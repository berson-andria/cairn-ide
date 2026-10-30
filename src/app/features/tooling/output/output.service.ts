import { Injectable, WritableSignal, computed, signal } from '@angular/core';

const MAX_LINES = 5000;

interface Channel {
  lines: string[];
  /** bumped (at most once per frame) when lines change, so streaming output does not re-render per line */
  rev: WritableSignal<number>;
  scheduled: boolean;
}

/**
 * Named output channels ("Engine", "Git", "Agent"...). Anything can append:
 *   output.append('Engine', 'model loaded');
 * To bring it into view: tooling.open('output') after output.show('Engine').
 */
@Injectable({ providedIn: 'root' })
export class OutputService {
  private readonly channels = new Map<string, Channel>();

  readonly names = signal<string[]>([]);
  readonly active = signal<string | null>(null);

  readonly activeText = computed(() => {
    const name = this.active();
    const channel = name ? this.channels.get(name) : undefined;
    if (!channel) return '';
    channel.rev(); // dependency
    return channel.lines.join('\n');
  });

  /** Appends whole lines (a trailing newline is ignored). */
  append(name: string, text: string): void {
    const channel = this.ensure(name);
    const parts = text.replace(/\r\n/g, '\n').split('\n');
    if (parts.at(-1) === '') parts.pop();
    for (const line of parts) channel.lines.push(line);
    if (channel.lines.length > MAX_LINES) channel.lines.splice(0, channel.lines.length - MAX_LINES);
    this.schedule(channel);
  }

  show(name: string): void {
    this.ensure(name);
    this.active.set(name);
  }

  clear(name: string | null = this.active()): void {
    const channel = name ? this.channels.get(name) : undefined;
    if (!channel) return;
    channel.lines.length = 0;
    channel.rev.update((v) => v + 1);
  }

  private ensure(name: string): Channel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { lines: [], rev: signal(0), scheduled: false };
      this.channels.set(name, channel);
      this.names.update((n) => [...n, name]);
      if (this.active() === null) this.active.set(name);
    }
    return channel;
  }

  private schedule(channel: Channel): void {
    if (channel.scheduled) return;
    channel.scheduled = true;
    requestAnimationFrame(() => {
      channel.scheduled = false;
      channel.rev.update((v) => v + 1);
    });
  }
}
