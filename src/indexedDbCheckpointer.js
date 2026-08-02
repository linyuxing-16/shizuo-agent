import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
} from '@langchain/langgraph-checkpoint';

const DEFAULT_DB_NAME = 'shizuo-agent-checkpoints';
const DB_VERSION = 1;
const CHECKPOINTS_STORE = 'checkpoints';
const WRITES_STORE = 'writes';

/**
 * 构造查询某个线程全部 checkpoint 的 IDBKeyRange
 *
 * checkpointId 为 uuid6 字符串（ASCII 十六进制 + 短横线），因此以
 * `''` 与 `'\uffff'` 作为上下界可以覆盖该线程命名空间下全部 ID。
 *
 * @param {string} threadId - 线程 ID
 * @param {string|undefined} checkpointNs - 可选命名空间过滤
 * @returns {IDBKeyRange} IndexedDB key range
 */
function checkpointsRange(threadId, checkpointNs) {
  if (checkpointNs === undefined) {
    return IDBKeyRange.bound([threadId, ''], [threadId, '\uffff']);
  }
  return IDBKeyRange.bound(
    [threadId, checkpointNs, ''],
    [threadId, checkpointNs, '\uffff'],
  );
}

/**
 * 构造查询某个 checkpoint 全部 pending writes 的 IDBKeyRange
 *
 * writes 的 keyPath 为 [threadId, checkpointNs, checkpointId, taskId, writeIdx]，
 * 第 4/5 个元素是字符串/数字；按 IndexedDB 键序规则，`[]`（数组）大于任意
 * 字符串/数字，因此用 `[tid, ns, cid, []]` 作为上界可覆盖全部 writes。
 *
 * @param {string} threadId - 线程 ID
 * @param {string} checkpointNs - 命名空间
 * @param {string} checkpointId - checkpoint ID
 * @returns {IDBKeyRange} IndexedDB key range
 */
function writesRange(threadId, checkpointNs, checkpointId) {
  return IDBKeyRange.bound(
    [threadId, checkpointNs, checkpointId],
    [threadId, checkpointNs, checkpointId, []],
  );
}

/**
 * 构造查询某个线程全部数据（checkpoints / writes）的 IDBKeyRange
 *
 * @param {string} threadId - 线程 ID
 * @returns {IDBKeyRange} IndexedDB key range
 */
function threadRange(threadId) {
  return IDBKeyRange.bound([threadId], [threadId, []]);
}

/**
 * 校验 config 中必须存在 thread_id，缺失时抛出中文错误
 *
 * @param {import('@langchain/core/runnables').RunnableConfig} config - 运行配置
 * @param {string} action - 操作描述（用于错误信息）
 * @returns {string} thread_id
 * @throws {Error} 缺少 thread_id 时抛出
 */
function requireThreadId(config, action) {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== 'string' || threadId === '') {
    throw new Error(
      `无法${action}：请在 config.configurable 中提供非空 thread_id`,
    );
  }
  return threadId;
}

/**
 * IndexedDB 持久化的 LangGraph checkpointer
 *
 * 实现 BaseCheckpointSaver 接口，将 checkpoint 与 pending writes 序列化后
 * 存入浏览器 IndexedDB，使对话上下文在页面刷新后仍然保留。所有读写方法
 * 均为异步，首次操作前需等待 {@link IndexedDBCheckpointer#ready}。
 *
 * @example
 * import { IndexedDBCheckpointer } from './indexedDbCheckpointer.js';
 *
 * const checkpointer = new IndexedDBCheckpointer();
 * await checkpointer.ready;
 * await checkpointer.put(
 *   { configurable: { thread_id: 'thread-1' } },
 *   checkpoint,
 *   { source: 'voice' },
 * );
 * const tuple = await checkpointer.getTuple(
 *   { configurable: { thread_id: 'thread-1' } },
 * );
 */
export class IndexedDBCheckpointer extends BaseCheckpointSaver {
  /**
   * @param {object} [options] - 构造参数
   * @param {string} [options.dbName] - IndexedDB 数据库名
   * @param {number} [options.version] - 数据库版本号
   */
  constructor({ dbName = DEFAULT_DB_NAME, version = DB_VERSION } = {}) {
    super();
    this.dbName = dbName;
    this.version = version;
    /** @type {Promise<IDBDatabase>} 数据库打开结果，失败时 reject */
    this.ready = this._openDatabase();
  }

  /**
   * 打开（必要时创建）IndexedDB 数据库
   *
   * @returns {Promise<IDBDatabase>} 数据库连接
   * @throws {Error} IndexedDB 不可用或打开失败时抛出中文错误
   */
  _openDatabase() {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(
        new Error('当前环境不支持 IndexedDB，无法持久化对话上下文'),
      );
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHECKPOINTS_STORE)) {
          db.createObjectStore(CHECKPOINTS_STORE, {
            keyPath: ['threadId', 'checkpointNs', 'checkpointId'],
          });
        }
        if (!db.objectStoreNames.contains(WRITES_STORE)) {
          db.createObjectStore(WRITES_STORE, {
            keyPath: ['threadId', 'checkpointNs', 'checkpointId', 'taskId', 'writeIdx'],
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('打开 IndexedDB 数据库失败'));
      request.onblocked = () =>
        reject(new Error('IndexedDB 数据库被其他页面占用，无法打开'));
    });
  }

  /**
   * 读取 object store 中匹配 range 的全部记录
   *
   * @param {string} storeName - store 名称
   * @param {IDBKeyRange} range - 查询范围
   * @returns {Promise<Array<object>>} 记录数组（按键升序）
   * @throws {Error} 数据库不可用或读取失败时抛出
   */
  async _readAll(storeName, range) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll(range);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('读取 IndexedDB 数据失败'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('读取 IndexedDB 事务被中止'));
    });
  }

  /**
   * 在单个读写事务中执行 store 写操作，事务提交后才 resolve
   *
   * @param {string} storeName - store 名称
   * @param {(store: IDBObjectStore) => void} operation - 同步执行 put/delete 等请求
   * @returns {Promise<void>} 事务提交完成
   * @throws {Error} 数据库不可用或写入失败时抛出
   */
  async _writeTx(storeName, operation) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, 'readwrite');
        operation(tx.objectStore(storeName));
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('写入 IndexedDB 数据失败'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('写入 IndexedDB 事务被中止'));
    });
  }

  /**
   * 将 store 记录还原为 CheckpointTuple
   *
   * @param {object} record - checkpoints store 中的原始记录
   * @param {import('@langchain/core/runnables').RunnableConfig} [config] - 优先使用的 config
   * @returns {Promise<import('@langchain/langgraph-checkpoint').CheckpointTuple>} checkpoint tuple
   */
  async _tupleFromRecord(record, config) {
    const [checkpoint, metadata] = await Promise.all([
      this.serde.loadsTyped('json', record.checkpoint),
      this.serde.loadsTyped('json', record.metadata),
    ]);
    const writes = await this._readAll(
      WRITES_STORE,
      writesRange(record.threadId, record.checkpointNs, record.checkpointId),
    );
    // IndexedDB 按键 [taskId, writeIdx] 升序返回，顺序确定且与写入顺序一致
    const pendingWrites = await Promise.all(
      writes.map(async (write) => [
        write.taskId,
        write.channel,
        await this.serde.loadsTyped('json', write.value),
      ]),
    );

    const tuple = {
      config: config ?? {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: record.checkpointNs,
          checkpoint_id: record.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (record.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: record.checkpointNs,
          checkpoint_id: record.parentCheckpointId,
        },
      };
    }
    return tuple;
  }

  /**
   * 获取指定配置对应的 checkpoint tuple
   *
   * 未提供 checkpoint_id 时返回该线程命名空间下最新（checkpointId 最大）的
   * checkpoint，与 MemorySaver 语义一致。
   *
   * @param {import('@langchain/core/runnables').RunnableConfig} config - 运行配置
   * @returns {Promise<import('@langchain/langgraph-checkpoint').CheckpointTuple|undefined>} checkpoint tuple，不存在时返回 undefined
   * @throws {Error} 缺少 thread_id 时抛出
   */
  async getTuple(config) {
    const threadId = requireThreadId(config, '获取 checkpoint');
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config);

    if (checkpointId) {
      const record = await this._readOne(CHECKPOINTS_STORE, [
        threadId,
        checkpointNs,
        checkpointId,
      ]);
      return record ? this._tupleFromRecord(record, config) : undefined;
    }

    const records = await this._readAll(
      CHECKPOINTS_STORE,
      checkpointsRange(threadId, checkpointNs),
    );
    if (records.length === 0) return undefined;
    records.sort((a, b) => b.checkpointId.localeCompare(a.checkpointId));
    return this._tupleFromRecord(records[0]);
  }

  /**
   * 读取单条记录
   *
   * @param {string} storeName - store 名称
   * @param {IDBValidKey} key - 记录主键
   * @returns {Promise<object|undefined>} 记录内容，不存在时为 undefined
   * @throws {Error} 数据库不可用或读取失败时抛出
   */
  async _readOne(storeName, key) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('读取 IndexedDB 数据失败'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('读取 IndexedDB 事务被中止'));
    });
  }

  /**
   * 列出匹配配置的 checkpoint tuple，按 checkpointId 降序
   *
   * @param {import('@langchain/core/runnables').RunnableConfig} config - 运行配置
   * @param {import('@langchain/langgraph-checkpoint').CheckpointListOptions} [options] - 过滤选项（before/limit/filter）
   * @yields {import('@langchain/langgraph-checkpoint').CheckpointTuple} checkpoint tuple
   * @throws {Error} 数据库不可用时抛出
   */
  async *list(config, options) {
    const { before, limit, filter } = options ?? {};
    const configuredThreadId = config.configurable?.thread_id;
    const configuredNs = config.configurable?.checkpoint_ns;
    const configuredCheckpointId = config.configurable?.checkpoint_id;
    const threadIds = configuredThreadId
      ? [configuredThreadId]
      : await this._distinctThreadIds();

    let remaining = limit;
    for (const threadId of threadIds) {
      const records = await this._readAll(
        CHECKPOINTS_STORE,
        checkpointsRange(threadId, configuredNs),
      );
      records.sort((a, b) => b.checkpointId.localeCompare(a.checkpointId));
      for (const record of records) {
        if (configuredCheckpointId && record.checkpointId !== configuredCheckpointId) {
          continue;
        }
        if (
          before?.configurable?.checkpoint_id &&
          record.checkpointId >= before.configurable.checkpoint_id
        ) {
          continue;
        }
        const metadata = await this.serde.loadsTyped('json', record.metadata);
        if (
          filter &&
          !Object.entries(filter).every(([key, value]) => metadata[key] === value)
        ) {
          continue;
        }
        if (remaining !== undefined) {
          if (remaining <= 0) return;
          remaining -= 1;
        }
        yield await this._tupleFromRecord(record);
      }
    }
  }

  /**
   * 收集全部已存在的线程 ID（按首次出现顺序）
   *
   * @returns {Promise<string[]>} 线程 ID 列表
   */
  async _distinctThreadIds() {
    const records = await this._readAll(CHECKPOINTS_STORE);
    const threadIds = [];
    for (const record of records) {
      if (!threadIds.includes(record.threadId)) threadIds.push(record.threadId);
    }
    return threadIds;
  }

  /**
   * 存储一个 checkpoint 快照
   *
   * @param {import('@langchain/core/runnables').RunnableConfig} config - 运行配置
   * @param {import('@langchain/langgraph-checkpoint').Checkpoint} checkpoint - checkpoint 数据
   * @param {import('@langchain/langgraph-checkpoint').CheckpointMetadata} metadata - 元数据
   * @param {object} [_newVersions] - 版本信息（本实现不使用，兼容接口签名）
   * @returns {Promise<import('@langchain/core/runnables').RunnableConfig>} 写入后的 config
   * @throws {Error} 缺少 thread_id 或写入失败时抛出
   */
  async put(config, checkpoint, metadata, _newVersions) {
    const threadId = requireThreadId(config, '写入 checkpoint');
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    if (!checkpoint?.id) {
      throw new Error('无法写入 checkpoint：checkpoint 缺少 id 字段');
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    await this._writeTx(CHECKPOINTS_STORE, (store) => {
      store.put({
        threadId,
        checkpointNs,
        checkpointId: checkpoint.id,
        checkpoint: serializedCheckpoint,
        metadata: serializedMetadata,
        parentCheckpointId: config.configurable?.checkpoint_id ?? null,
      });
    });
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * 存储与 checkpoint 关联的 pending writes
   *
   * 以 [taskId, writeIdx] 为幂等键：已存在的写入跳过，避免节点重跑时重复存储。
   *
   * @param {import('@langchain/core/runnables').RunnableConfig} config - 运行配置
   * @param {import('@langchain/langgraph-checkpoint').PendingWrite[]} writes - 待写入数据
   * @param {string} taskId - 任务 ID
   * @returns {Promise<void>} 写入完成
   * @throws {Error} 缺少 thread_id/checkpoint_id 或写入失败时抛出
   */
  async putWrites(config, writes, taskId) {
    const threadId = requireThreadId(config, '写入 pending writes');
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = config.configurable?.checkpoint_id;
    if (!checkpointId) {
      throw new Error(
        '无法写入 pending writes：请在 config.configurable 中提供 checkpoint_id',
      );
    }

    const prepared = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
        const [, serializedValue] = await this.serde.dumpsTyped(value);
        return { channel, writeIdx, serializedValue };
      }),
    );
    const range = writesRange(threadId, checkpointNs, checkpointId);
    await this._writeTx(WRITES_STORE, (store) => {
      const existingKeys = new Set();
      const existingRequest = store.getAll(range);
      existingRequest.onsuccess = () => {
        for (const record of existingRequest.result) {
          existingKeys.add(`${record.taskId}:${record.writeIdx}`);
        }
        for (const { channel, writeIdx, serializedValue } of prepared) {
          if (existingKeys.has(`${taskId}:${writeIdx}`)) continue;
          store.put({
            threadId,
            checkpointNs,
            checkpointId,
            taskId,
            writeIdx,
            channel,
            value: serializedValue,
          });
        }
      };
    });
  }

  /**
   * 删除某线程的全部 checkpoint 与 pending writes
   *
   * @param {string} threadId - 线程 ID
   * @returns {Promise<void>} 删除完成
   * @throws {Error} threadId 无效或删除失败时抛出
   */
  async deleteThread(threadId) {
    if (typeof threadId !== 'string' || threadId === '') {
      throw new Error('deleteThread 需要有效的 thread_id');
    }
    const db = await this.ready;
    await new Promise((resolve, reject) => {
      const tx = db.transaction([CHECKPOINTS_STORE, WRITES_STORE], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('删除 IndexedDB 数据失败'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('删除 IndexedDB 事务被中止'));
      for (const storeName of [CHECKPOINTS_STORE, WRITES_STORE]) {
        const store = tx.objectStore(storeName);
        const cursorRequest = store.openCursor(threadRange(threadId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        cursorRequest.onerror = () =>
          reject(cursorRequest.error ?? new Error('删除 IndexedDB 数据失败'));
      }
    });
  }
}
