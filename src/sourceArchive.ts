import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { extractConversationRecords } from './archive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';

const pageSize = 128;
/** The host no longer stores this session at all — nothing left to replay; keep what was already archived. */
const isNotFound = (error: unknown) => error instanceof Error && error.name === 'SessionPersistenceNotFoundError';
/**
 * A session log the host itself cannot read (a compaction cut off mid-write, a half-flushed turn). It is not
 * our bug and it never fixes itself, so retrying adds nothing — one broken conversation must not cost her the
 * whole world: flushed and thrown, it fails the plugin's load and every session loses its memory block.
 */
export function isCorruptSessionLog(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /stored log is corrupt|SessionFormatError|does not match an open turn/i.test(text);
}
export function belongsToWorld(session: Pick<Session, 'header'>, config: WorldConfig): boolean {
  const header = session.header;
  return header.agentPreset === config.agentPreset && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0;
}

/**
 * Copies her conversations from the host's session logs into the archive. Each session is replayed from where
 * the archive left off; replays run one at a time, and a session already queued is not queued twice. Sessions
 * outside `archived` are left alone.
 */
export function createSourceArchive(ctx: Context, config: WorldConfig, store: ArchiveStore, archived: (sessionId: string) => boolean = () => true) {
  const dirty = new Set<string>();
  const jobs = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  let tail = Promise.resolve();

  /** Copies what the archive has not seen yet; `skip` moves past it without keeping it. */
  async function replay(sessionId: string, skip = false): Promise<void> {
    const id = SessionId(sessionId);
    const live = ctx.sessions.get(id);
    if (live) await ctx.sessions.flush(live);
    // A deleted session keeps what it already archived; there is nothing left to replay.
    const handle = await ctx.sessionPersistence.open(id, 'read').catch(error => {
      if (isNotFound(error)) { ctx.logger.warn(`dsh-world: session ${sessionId} is no longer stored; skipping replay`); store.forgetProgress(sessionId); return undefined; }
      throw error;
    });
    if (!handle) return;
    try {
      let { nextSeq, turn } = store.progress(id);
      while (true) {
        const { events } = await handle.read(nextSeq, pageSize);
        if (!events.length) break;
        const records = events.flatMap(event => {
          if (event.type === 'turn/start') turn = event.data.turn;
          return skip ? [] : extractConversationRecords(event, { ...config, header: handle.header, inheritedEventCount: handle.inheritedEventCount, turn });
        });
        nextSeq = events.at(-1)!.seq + 1;
        await store.commitRecords(records, { sessionId: id, nextSeq, turn });
      }
    } finally { await handle.close(); }
  }
  /** Runs after every queued replay. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const job = tail.then(work);
    tail = job.catch(error => { ctx.logger.error(error); });
    return job;
  }
  function schedule(sessionId: string): Promise<void> {
    // Not archived itself, it still waits for the replays already queued, so its memory block is current.
    if (!archived(sessionId)) return tail;
    dirty.add(sessionId);
    const pending = jobs.get(sessionId);
    if (pending) return pending;
    const job = tail.then(async () => {
      while (dirty.delete(sessionId)) await replay(sessionId);
      failures.delete(sessionId);
    });
    jobs.set(sessionId, job);
    tail = job.catch(error => {
      // Skips and a warning instead of a stored failure — see `isCorruptSessionLog`.
      if (isCorruptSessionLog(error)) { dirty.delete(sessionId); ctx.logger.warn(`dsh-world: 会话 ${sessionId} 的日志读不动，先跳过（这段对话不归档）`); return; }
      failures.set(sessionId, error); ctx.logger.error(error);
    }).finally(() => { jobs.delete(sessionId); });
    return job;
  }
  return {
    schedule,
    /**
     * Every session the archive has seen, replayed again so nothing written while the plugin was not loaded is
     * missed; with `skip`, what was said while her world was stopped is passed over instead.
     */
    async catchUp(skip = false): Promise<void> {
      // One session's failure is kept for flush(); it must not stop the sessions after it.
      const replayOne = (id: string) => (skip ? enqueue(() => replay(id, true)) : schedule(id)).catch(() => {});
      let after = '';
      for (let ids = store.sourcePage(after); ids.length; ids = store.sourcePage(after)) {
        for (const id of ids) {
          after = id;
          // A session deleted from the host (not merely archived there) keeps its records but has nothing left to resume.
          if (!await ctx.sessionPersistence.stat(SessionId(id))) { store.forgetProgress(id); continue; }
          await replayOne(id);
        }
      }
    },
    /** Moves past everything a session holds now without keeping it (said while her world was stopped). */
    skip: (sessionId: string) => enqueue(() => replay(sessionId, true)),
    /** Waits for every queued replay; rejects while any session still has an unresolved failure. */
    async flush(): Promise<void> {
      let current: Promise<void>;
      do { current = tail; await current; } while (current !== tail);
      if (failures.size) throw new AggregateError([...failures.values()], 'dsh-world: source archive has unresolved failures');
    },
  };
}
