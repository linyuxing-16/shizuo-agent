import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { IndexedDBCheckpointer } from './indexedDbCheckpointer.js';

// 每个用例使用独立数据库名，避免连接占用导致 deleteDatabase 阻塞
let dbCounter = 0;
const nextDbName = () => `test-checkpoint-db-${++dbCounter}`;

function makeCheckpoint(id, overrides = {}) {
  return {
    v: 4,
    ts: '2026-01-01T00:00:00.000Z',
    id,
    channel_values: { counter: 0 },
    channel_versions: {},
    versions_seen: {},
    ...overrides,
  };
}

async function collect(checkpointer, config, options) {
  const tuples = [];
  for await (const tuple of checkpointer.list(config, options)) {
    tuples.push(tuple);
  }
  return tuples;
}

describe('IndexedDBCheckpointer', () => {
  it('put 后 getTuple 能完整还原 checkpoint 与 metadata', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;

    const checkpoint = makeCheckpoint('0001-aaa', {
      channel_values: {
        counter: 1,
        messages: [{ type: 'human', content: '你好' }],
      },
    });
    const writeConfig = { configurable: { thread_id: 'thread-1' } };

    const result = await cp.put(writeConfig, checkpoint, { source: 'voice' });
    expect(result.configurable.checkpoint_id).toBe('0001-aaa');

    const tuple = await cp.getTuple(result);
    expect(tuple.checkpoint.id).toBe('0001-aaa');
    expect(tuple.checkpoint.channel_values.counter).toBe(1);
    expect(tuple.checkpoint.channel_values.messages).toEqual([
      { type: 'human', content: '你好' },
    ]);
    expect(tuple.metadata).toEqual({ source: 'voice' });
    expect(tuple.pendingWrites).toEqual([]);
    expect(tuple.parentConfig).toBeUndefined();
  });

  it('写入时记录 parentConfig 供时间回溯使用', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;

    await cp.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint('0001-aaa'),
      {},
    );
    await cp.put(
      { configurable: { thread_id: 'thread-1', checkpoint_id: '0001-aaa' } },
      makeCheckpoint('0002-bbb'),
      {},
    );

    const tuple = await cp.getTuple({
      configurable: { thread_id: 'thread-1', checkpoint_id: '0002-bbb' },
    });
    expect(tuple.parentConfig.configurable.checkpoint_id).toBe('0001-aaa');
  });

  it('未指定 checkpoint_id 时返回线程内最新的 checkpoint', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;

    await cp.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint('0001-aaa'),
      {},
    );
    await cp.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint('0002-bbb'),
      {},
    );

    const tuple = await cp.getTuple({ configurable: { thread_id: 'thread-1' } });
    expect(tuple.config.configurable.checkpoint_id).toBe('0002-bbb');
    expect(tuple.checkpoint.id).toBe('0002-bbb');
  });

  it('putWrites 写入 pendingWrites，且相同 taskId 重复写入被跳过', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;

    await cp.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint('0001-aaa'),
      {},
    );
    const writeConfig = {
      configurable: { thread_id: 'thread-1', checkpoint_id: '0001-aaa' },
    };
    await cp.putWrites(
      writeConfig,
      [
        ['messages', { content: '你好' }],
        ['counter', 42],
      ],
      'task-1',
    );
    // 同 taskId + 同 channel 的重复写入应被幂等跳过
    await cp.putWrites(writeConfig, [['messages', { content: '重复' }]], 'task-1');
    await cp.putWrites(writeConfig, [['other', 'x']], 'task-2');

    const tuple = await cp.getTuple(writeConfig);
    expect(tuple.pendingWrites).toHaveLength(3);
    expect(tuple.pendingWrites[0]).toEqual(['task-1', 'messages', { content: '你好' }]);
    expect(tuple.pendingWrites[1]).toEqual(['task-1', 'counter', 42]);
    expect(tuple.pendingWrites[2]).toEqual(['task-2', 'other', 'x']);
  });

  it('list 按 checkpointId 降序，支持 before/limit/filter', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;
    const config = { configurable: { thread_id: 'thread-1' } };

    await cp.put(config, makeCheckpoint('0001-aaa'), { source: 'voice' });
    await cp.put(config, makeCheckpoint('0002-bbb'), { source: 'text' });
    await cp.put(config, makeCheckpoint('0003-ccc'), { source: 'voice' });

    const ids = (await collect(cp, config)).map((t) => t.checkpoint.id);
    expect(ids).toEqual(['0003-ccc', '0002-bbb', '0001-aaa']);

    const before = await collect(cp, config, {
      before: { configurable: { checkpoint_id: '0003-ccc' } },
    });
    expect(before.map((t) => t.checkpoint.id)).toEqual(['0002-bbb', '0001-aaa']);

    const limited = await collect(cp, config, { limit: 2 });
    expect(limited).toHaveLength(2);

    const filtered = await collect(cp, config, { filter: { source: 'voice' } });
    expect(filtered.map((t) => t.checkpoint.id)).toEqual(['0003-ccc', '0001-aaa']);
  });

  it('deleteThread 同时清除该线程的 checkpoints 与 writes', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;

    await cp.put(
      { configurable: { thread_id: 'thread-a' } },
      makeCheckpoint('0001-aaa'),
      {},
    );
    await cp.putWrites(
      { configurable: { thread_id: 'thread-a', checkpoint_id: '0001-aaa' } },
      [['messages', 'x']],
      'task-1',
    );
    await cp.put(
      { configurable: { thread_id: 'thread-b' } },
      makeCheckpoint('0001-aaa'),
      {},
    );

    await cp.deleteThread('thread-a');
    expect(
      await cp.getTuple({ configurable: { thread_id: 'thread-a' } }),
    ).toBeUndefined();
    expect(
      await cp.getTuple({ configurable: { thread_id: 'thread-b' } }),
    ).toBeTruthy();
  });

  it('新实例共享同一数据库，模拟刷新后上下文仍然保留', async () => {
    const dbName = nextDbName();
    const cp1 = new IndexedDBCheckpointer({ dbName });
    await cp1.ready;
    await cp1.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint('0001-aaa'),
      {},
    );

    const cp2 = new IndexedDBCheckpointer({ dbName });
    await cp2.ready;
    const tuple = await cp2.getTuple({ configurable: { thread_id: 'thread-1' } });
    expect(tuple.checkpoint.id).toBe('0001-aaa');
  });

  it('缺少 thread_id 时 put 抛出中文错误', async () => {
    const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
    await cp.ready;
    await expect(cp.put({ configurable: {} }, makeCheckpoint('0001-aaa'), {}))
      .rejects.toThrow('thread_id');
  });

  it('IndexedDB 不可用时 ready 以中文错误拒绝', async () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      const cp = new IndexedDBCheckpointer({ dbName: nextDbName() });
      await expect(cp.ready).rejects.toThrow('IndexedDB');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
