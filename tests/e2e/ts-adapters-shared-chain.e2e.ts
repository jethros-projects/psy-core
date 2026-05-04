import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function importDist<T extends Record<string, unknown>>(distPath: string): Promise<T> {
  return await import(pathToFileURL(path.join(repoRoot, 'dist', distPath)).href) as T;
}

function anthropicHandlers() {
  return {
    view: async () => 'viewed',
    create: async () => 'created',
    str_replace: async () => 'replaced',
    insert: async () => 'inserted',
    delete: async () => 'deleted',
    rename: async () => 'renamed',
  };
}

function lettaBlocks() {
  return {
    create: async (body: { label?: string; value?: string }) => ({
      id: 'blk_e2e',
      label: body.label ?? 'human',
      value: body.value ?? '',
      description: null,
    }),
  };
}

function mastraMemory() {
  return {
    updateWorkingMemory: async () => undefined,
  };
}

function mem0Client() {
  return {
    add: async () => [{
      id: 'mem_e2e',
      memory: 'e2e memory',
      user_id: 'u_e2e',
      metadata: null,
    }],
  };
}

function langChainHistory() {
  const messages: unknown[] = [];
  return {
    addMessage: async (message: unknown) => {
      messages.push(message);
    },
  };
}

function langGraphSaver() {
  return {
    put: async (config: unknown) => config,
  };
}

function gbrainOperation() {
  return {
    name: 'put_page',
    scope: 'write',
    mutating: true,
    handler: async () => ({ ok: true }),
  };
}

describe('built package integration board', () => {
  it('records Anthropic, Letta, Mastra, Mem0, LangChain, LangGraph, and GBrain into one verifiable chain', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'psy-integrations-board-'));
    const core = await importDist<{
      initConfig: (options: { cwd: string }) => Promise<{ paths: { configPath: string } }>;
      query: (options: { configPath: string }) => Promise<Array<{
        operation: string;
        audit_phase: string;
        actor_id: string | null;
        session_id: string | null;
        memory_path: string;
      }>>;
      verify: (options: { configPath: string }) => Promise<{ ok: boolean; issues: unknown[] }>;
    }>('index.js');
    const { paths } = await core.initConfig({ cwd });
    const configPath = paths.configPath;

    const [
      anthropic,
      letta,
      mastra,
      mem0,
      langchain,
      langgraph,
      gbrain,
    ] = await Promise.all([
      importDist<{ wrap: (target: unknown, options: Record<string, unknown>) => any }>('anthropic-memory/index.js'),
      importDist<{ wrap: (target: unknown, options: Record<string, unknown>) => any }>('letta/index.js'),
      importDist<{ wrap: (target: unknown, options: Record<string, unknown>) => any }>('mastra/index.js'),
      importDist<{ wrap: (target: unknown, options: Record<string, unknown>) => any }>('mem0/index.js'),
      importDist<{ wrap: (target: unknown, options: Record<string, unknown>) => any }>('langchain/index.js'),
      importDist<{ wrap: (target: unknown, options: Record<string, unknown>) => any }>('langgraph/index.js'),
      importDist<{ wrapOperations: (target: unknown[], options: Record<string, unknown>) => any[] }>('gbrain/index.js'),
    ]);

    await anthropic.wrap(anthropicHandlers(), {
      actorId: 'integration-board',
      configPath,
    }).create({ command: 'create', path: '/memories/anthropic.md', file_text: 'alpha' });

    await letta.wrap(lettaBlocks(), {
      actorId: 'integration-board',
      configPath,
    }).create({ label: 'human', value: 'letta alpha' });

    await mastra.wrap(mastraMemory(), {
      actorId: 'integration-board',
      configPath,
    }).updateWorkingMemory({
      threadId: 'thread_e2e',
      resourceId: 'resource_e2e',
      workingMemory: 'mastra alpha',
    });

    await mem0.wrap(mem0Client(), {
      actorId: 'integration-board',
      configPath,
    }).add([{ role: 'user', content: 'remember alpha' }], { userId: 'user_e2e' });

    await langchain.wrap(langChainHistory(), {
      actorId: 'integration-board',
      sessionId: 'lc_session_e2e',
      configPath,
    }).addMessage({ type: 'human', content: 'langchain alpha', _getType: () => 'human' });

    await langgraph.wrap(langGraphSaver(), {
      actorId: 'integration-board',
      configPath,
    }).put(
      { configurable: { thread_id: 'lg_thread_e2e', checkpoint_ns: '', checkpoint_id: 'cp_parent' } },
      { id: 'cp_e2e', ts: '2026-05-04T00:00:00.000Z', channel_values: {}, v: 1 },
      { source: 'e2e' },
      {},
    );

    const [wrappedGbrain] = gbrain.wrapOperations([gbrainOperation()], {
      actorId: 'integration-board',
      configPath,
    });
    await wrappedGbrain.handler({ brainId: 'brain_e2e', jobId: 42 }, { slug: 'people/alice' });

    const events = await core.query({ configPath });
    expect(events).toHaveLength(14);
    expect(events.map((event) => `${event.operation}:${event.audit_phase}`)).toEqual([
      'create:intent',
      'create:result',
      'create:intent',
      'create:result',
      'str_replace:intent',
      'str_replace:result',
      'create:intent',
      'create:result',
      'insert:intent',
      'insert:result',
      'create:intent',
      'create:result',
      'str_replace:intent',
      'str_replace:result',
    ]);
    expect(events.filter((event) => event.actor_id === 'integration-board')).toHaveLength(14);
    expect(events.map((event) => event.memory_path)).toEqual([
      '/memories/anthropic.md',
      '/memories/anthropic.md',
      'letta://blocks/label:human',
      'letta://blocks/label:human',
      'mastra://working-memory/resource_e2e',
      'mastra://working-memory/resource_e2e',
      'mem0://users/user_e2e/pending',
      'mem0://users/user_e2e/pending',
      'langchain://sessions/lc_session_e2e/messages/1',
      'langchain://sessions/lc_session_e2e/messages/1',
      'langgraph://threads/lg_thread_e2e/_/cp_e2e',
      'langgraph://threads/lg_thread_e2e/_/cp_e2e',
      'gbrain://brains/brain_e2e/pages/people/alice',
      'gbrain://brains/brain_e2e/pages/people/alice',
    ]);

    const verification = await core.verify({ configPath });
    expect(verification).toMatchObject({ ok: true });
    expect(verification.issues).toEqual([]);
  });
});
