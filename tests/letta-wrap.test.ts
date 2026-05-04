import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { wrap } from '../src/adapters/letta/wrap.js';
import type {
  AgentBlocksResource,
  BlockResponse,
  BlocksResource,
} from '../src/adapters/letta/types.js';
import { initProject } from './helpers.js';

function blockResponse(overrides: Partial<BlockResponse> = {}): BlockResponse {
  return {
    id: 'blk_default',
    label: 'human',
    value: 'default value',
    description: null,
    ...overrides,
  };
}

function stubBlocks(): BlocksResource & {
  create: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async () => blockResponse({ id: 'blk_created', label: 'human', value: 'hello' })),
    retrieve: vi.fn(async (id: string) => blockResponse({ id })),
    update: vi.fn(async (id: string, body) => blockResponse({ id, value: body.value ?? 'kept' })),
    delete: vi.fn(async () => ({ ok: true })),
    list: vi.fn(async () => ({ data: [], has_more: false })),
  } as unknown as ReturnType<typeof stubBlocks>;
}

function stubAgentBlocks(): AgentBlocksResource & {
  retrieve: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
} {
  return {
    retrieve: vi.fn(async (label: string, params) =>
      blockResponse({ id: `blk_${params.agent_id}_${label}`, label }),
    ),
    update: vi.fn(async (label: string, body) =>
      blockResponse({ id: `blk_${body.agent_id}_${label}`, label, value: body.value ?? 'kept' }),
    ),
    attach: vi.fn(async () => ({ ok: true })),
  } as unknown as ReturnType<typeof stubAgentBlocks>;
}

async function readEvents(paths: { sqlitePath: string; archivesPath: string }, config: unknown) {
  const { PsyStore } = await import('../src/store.js');
  const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config: config as never });
  const events = store.allActiveEvents();
  store.close();
  return events;
}

describe('letta wrap (global blocks)', () => {
  it('writes intent + result for create/retrieve/update/delete', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.create({ label: 'human', value: 'hello' });
    await audited.retrieve('blk_42');
    await audited.update('blk_42', { value: 'updated' });
    await audited.delete('blk_42');

    const events = await readEvents(paths, config);
    const phases = events.map((e) => `${e.operation}:${e.audit_phase}`);
    expect(phases).toEqual([
      'create:intent', 'create:result',
      'view:intent', 'view:result',
      'str_replace:intent', 'str_replace:result',
      'delete:intent', 'delete:result',
    ]);
    expect(events[0]?.memory_path).toBe('letta://blocks/label:human');
    expect(events[2]?.memory_path).toBe('letta://blocks/blk_42');
    expect(target.create).toHaveBeenCalledOnce();
    expect(target.retrieve).toHaveBeenCalledWith('blk_42', undefined);
  });

  it('proxy passes through unwrapped methods like list', async () => {
    const { paths } = await initProject();
    const target = stubBlocks();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    const result = await (audited.list as () => Promise<unknown>)();
    expect(result).toEqual({ data: [], has_more: false });
    expect(target.list).toHaveBeenCalledOnce();
  });

  it('forwards create call options and returns the exact SDK response object', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const expected = blockResponse({ id: 'blk_exact', label: 'persona', value: 'precise' });
    target.create.mockResolvedValueOnce(expected);
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });
    const body = { label: 'persona', value: 'precise' };
    const callOpts = { headers: { 'x-request-id': 'req-1' } };

    const result = await audited.create(body, callOpts);

    expect(result).toBe(expected);
    expect(target.create).toHaveBeenCalledWith(body, callOpts);
    const events = await readEvents(paths, config);
    const payload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview) : null;
    expect(payload?.__psy_audit?.result).toEqual({ kind: 'unknown' });
  });

  it('rethrows the exact SDK error object from global calls', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const error = Object.assign(new Error('letta rate limited'), { code: 'rate_limit' });
    target.retrieve.mockRejectedValueOnce(error);
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(audited.retrieve('blk_42')).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_code).toBe('rate_limit');
    expect(events.at(-1)?.error_message).toBe('letta rate limited');
  });

  it('lets explicit identity override both options actorId and context actorId', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const audited = wrap(target, {
      identity: 'identity-actor',
      actorId: 'option-actor',
      configPath: paths.configPath,
    });

    await runWithContext({ actorId: 'ctx-actor', tenantId: 'ctx-tenant' }, () =>
      audited.retrieve('blk_42'),
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('identity-actor');
    expect(events[0]?.tenant_id).toBe('ctx-tenant');
  });

  it('rejects anonymous calls with PsyConfigInvalid and records validation_error', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const audited = wrap(target, { configPath: paths.configPath });

    await expect(audited.retrieve('blk_x')).rejects.toBeInstanceOf(PsyConfigInvalid);
    expect(target.retrieve).not.toHaveBeenCalled();

    const events = await readEvents(paths, config);
    expect(events.map((e) => e.audit_phase)).toEqual(['intent', 'result']);
    expect(events[1]?.outcome).toBe('rejected_by_anonymous_check');
  });

  it('records handler error and rethrows', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    target.update.mockRejectedValueOnce(new Error('letta 500'));
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(audited.update('blk_42', { value: 'x' })).rejects.toThrow('letta 500');

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_message).toBe('letta 500');
  });

  it('uses identity from runWithContext when actorId is not in options', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const audited = wrap(target, { configPath: paths.configPath });

    await runWithContext({ actorId: 'ctx-actor', tenantId: 't-1' }, () =>
      audited.retrieve('blk_42'),
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('ctx-actor');
    expect(events[0]?.tenant_id).toBe('t-1');
  });
});

describe('letta wrap (agent-scoped blocks)', () => {
  it('writes intent + result for retrieve/update with agent path', async () => {
    const { paths, config } = await initProject();
    const target = stubAgentBlocks();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.retrieve('human', { agent_id: 'agent_1' });
    await audited.update('persona', { agent_id: 'agent_1', value: 'I am helpful' });

    const events = await readEvents(paths, config);
    expect(events.map((e) => e.memory_path)).toEqual([
      'letta://agents/agent_1/blocks/human',
      'letta://agents/agent_1/blocks/human',
      'letta://agents/agent_1/blocks/persona',
      'letta://agents/agent_1/blocks/persona',
    ]);
    expect(events.map((e) => e.operation)).toEqual([
      'view', 'view',
      'str_replace', 'str_replace',
    ]);
  });

  it('passes through attach without auditing', async () => {
    const { paths } = await initProject();
    const target = stubAgentBlocks();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.attach('blk_42', { agent_id: 'agent_1' });
    expect(target.attach).toHaveBeenCalledWith('blk_42', { agent_id: 'agent_1' });
  });

  it('forwards agent-scoped update call options without changing the response', async () => {
    const { paths, config } = await initProject();
    const target = stubAgentBlocks();
    const expected = blockResponse({ id: 'blk_agent_persona', label: 'persona', value: 'v2' });
    target.update.mockResolvedValueOnce(expected);
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });
    const body = { agent_id: 'agent_1', value: 'v2' };
    const callOpts = { timeout: 5000 };

    const result = await audited.update('persona', body, callOpts);

    expect(result).toBe(expected);
    expect(target.update).toHaveBeenCalledWith('persona', body, callOpts);
    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('letta://agents/agent_1/blocks/persona');
  });
});

describe('letta wrap (dispatch)', () => {
  it('detects agent-scoped resource via the attach method', async () => {
    const { paths, config } = await initProject();
    const target = stubAgentBlocks();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.retrieve('human', { agent_id: 'agent_1' });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('letta://agents/agent_1/blocks/human');
  });

  it('falls back to global wrapping when attach is absent', async () => {
    const { paths, config } = await initProject();
    const target = stubBlocks();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.retrieve('blk_42');

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('letta://blocks/blk_42');
  });
});
