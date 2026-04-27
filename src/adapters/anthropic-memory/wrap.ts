import type { MemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';

import { Auditor } from '../../auditor.js';
import type { MemoryCommand, WrapOptions } from '../../types.js';

const COMMANDS = ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] as const;

export function wrap(handlers: MemoryToolHandlers, opts: WrapOptions = {}): MemoryToolHandlers {
  validateHandlers(handlers);
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => {
    auditorPromise ??= Auditor.create(opts);
    return auditorPromise;
  };

  const wrapCommand = (async (input: MemoryCommand) => {
    const auditor = await getAuditor();
    return auditor.recordCommand(handlers as unknown as Record<string, (command: MemoryCommand) => unknown>, input);
  });

  return {
    view: wrapCommand as MemoryToolHandlers['view'],
    create: wrapCommand as MemoryToolHandlers['create'],
    str_replace: wrapCommand as MemoryToolHandlers['str_replace'],
    insert: wrapCommand as MemoryToolHandlers['insert'],
    delete: wrapCommand as MemoryToolHandlers['delete'],
    rename: wrapCommand as MemoryToolHandlers['rename'],
  };
}

function validateHandlers(handlers: MemoryToolHandlers): void {
  for (const command of COMMANDS) {
    if (typeof handlers[command] !== 'function') {
      throw new TypeError(`MemoryToolHandlers.${command} must be a function`);
    }
  }
}
