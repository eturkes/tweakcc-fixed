import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import {
  attachFffCompaction,
  bindFffSession,
  buildFffContextRuntime,
} from './fffContext';

function harness() {
  const cwd = '/tmp/synthetic';
  const session = { id: 'session-one', project: { cwd } };
  const toolContext = { session };
  const context = vm.createContext({ process: { cwd: () => '/tmp/startup' } });
  vm.runInContext(buildFffContextRuntime('/tmp/rg-fff'), context);
  const rpc = vi.fn().mockResolvedValue(null);
  context.__tweakccFffExec = rpc;
  context.__tweakccFffBind('session-one', () => session.project.cwd);
  return {
    context,
    rpc,
    toolContext,
    cwd: (value: string) => (session.project.cwd = value),
  };
}

describe('fff session context', () => {
  it('binds only main-session submissions before the existing router call', () => {
    const source =
      'async function submit(e,t,n,r){let model=r.options.mainLoopModel,E=e;' +
      'if(E===null&&t!=="prompt")throw Error(`Mode: ${t} requires a string input.`);' +
      'await globalThis.__tweakccRouterClassify(E);return model}';
    const patched = bindFffSession(source, '/tmp/rg-fff')!;
    expect(patched).toContain('if(!r.agentId)');
    expect(patched).toContain('__tweakccFffBind(r.session?.id,');
    expect(patched.indexOf('__tweakccFffBind(r.session?.id,')).toBeLessThan(
      patched.indexOf('await globalThis.__tweakccRouterClassify')
    );
    expect(() => new Function(patched)).not.toThrow();
    expect(bindFffSession(patched, '/tmp/rg-fff')).toBe(patched);
  });

  it('enriches both summaryText and the model-visible summary, preserving failed compactions', async () => {
    const source =
      'async function compact(response,params){let arm=armFor(),native=contextPath(params.toolUseContext),unused=0;let summary=extract(response.messages);' +
      'if(!summary)return log(Error("Reactive compact: empty summary text in summarization response")),{ok:!1};' +
      'let warning;return globalThis.__tweakccRouter&&' +
      '(globalThis.__tweakccRouter.pendingCompaction=summary),{ok:!0,summaryText:summary,messages:[message(summary)],scopeWarned:warning}}';
    const patched = attachFffCompaction(source)!;
    expect(attachFffCompaction(patched)).toBe(patched);
    const context = vm.createContext({
      extract: (messages: string[]) => messages[0],
      armFor: () => 'synthetic',
      contextPath: () => null,
      message: (text: string) => ({ text }),
      log: () => {},
      __tweakccRouter: {},
      __tweakccFffCompact: async (text: string) => text + '\nsynthetic hint',
    });
    vm.runInContext(patched, context);
    const result = await context.compact(
      { messages: ['Original summary'] },
      { toolUseContext: {} }
    );
    expect(result.summaryText).toBe('Original summary\nsynthetic hint');
    expect(result.messages[0].text).toBe(result.summaryText);
    expect(context.__tweakccRouter.pendingCompaction).toBe(result.summaryText);
    expect(
      (await context.compact({ messages: [] }, { toolUseContext: {} })).ok
    ).toBe(false);
    context.__tweakccFffCompact = async () => {
      throw Error('unavailable');
    };
    expect(
      (
        await context.compact(
          { messages: ['Original'] },
          { toolUseContext: {} }
        )
      ).summaryText
    ).toBe('Original');
  });

  it('bounds pointers, rejects unsafe paths, and avoids duplicated notes', async () => {
    const h = harness();
    h.rpc.mockResolvedValue([
      '../foreign',
      '/absolute',
      'bad\npath',
      ...Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`),
    ]);
    const result = await h.context.__tweakccFffCompact(
      'Summary',
      h.toolContext
    );
    expect(result).not.toContain('foreign');
    expect(result).not.toContain('/absolute');
    expect(result).not.toContain('bad');
    expect(result.match(/"src\/file-/g)).toHaveLength(8);
    expect(result.length - 'Summary'.length).toBeLessThanOrEqual(2048);
    expect(await h.context.__tweakccFffCompact(result, h.toolContext)).toBe(
      result
    );
    expect(h.rpc).toHaveBeenCalledTimes(1);
    h.rpc.mockResolvedValue(null);
    expect(
      await h.context.__tweakccFffCompact('Unchanged', h.toolContext)
    ).toBe('Unchanged');
  });

  it('rejects stale results after a session or working directory change', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.rpc.mockImplementation(() => new Promise(done => (resolve = done)));
    const pending = h.context.__tweakccFffCompact('Summary', h.toolContext);
    h.context.__tweakccFffBind(
      'session-two',
      () => h.toolContext.session.project.cwd
    );
    resolve(['src/old.ts']);
    expect(await pending).toBe('Summary');
    h.toolContext.session.id = 'session-two';
    const changedCwd = h.context.__tweakccFffCompact('Summary', h.toolContext);
    h.cwd('/tmp/elsewhere');
    resolve(['src/old.ts']);
    expect(await changedCwd).toBe('Summary');
    expect(h.context.__tweakccFffScope('session-one')).toBeNull();
  });

  it('omits pointers for subagents and mismatched compaction sessions', async () => {
    const h = harness();
    h.rpc.mockResolvedValue(['src/main.ts']);
    expect(
      await h.context.__tweakccFffCompact('Summary', {
        ...h.toolContext,
        agentId: 'subagent',
      })
    ).toBe('Summary');
    expect(
      await h.context.__tweakccFffCompact('Summary', {
        session: { id: 'another', project: { cwd: '/tmp/synthetic' } },
      })
    ).toBe('Summary');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('rejects an in-place session-id change while pointers are pending', async () => {
    const h = harness();
    let resolve!: (paths: string[]) => void;
    h.rpc.mockImplementation(() => new Promise(done => (resolve = done)));
    const pending = h.context.__tweakccFffCompact('Summary', h.toolContext);
    h.toolContext.session.id = 'changed-in-place';
    resolve(['src/previous-session.ts']);
    expect(await pending).toBe('Summary');
  });

  it('uses the live session cwd while process cwd stays at startup', async () => {
    const h = harness();
    h.rpc.mockResolvedValue(['current.ts']);
    h.cwd('/tmp/synthetic/changed');
    const result = await h.context.__tweakccFffCompact(
      'Summary',
      h.toolContext
    );
    expect(result).toContain('current.ts');
    expect(h.rpc).toHaveBeenCalledWith(
      ['--context', 'session-one'],
      250,
      '/tmp/synthetic/changed'
    );
    await h.context.__tweakccFffRefresh();
    expect(h.rpc).toHaveBeenCalledWith(
      ['--scope', 'session-one'],
      250,
      '/tmp/synthetic/changed'
    );
  });

  it('serves only fresh scope for the current session and directory without waiting', async () => {
    const h = harness();
    const counts = {
      indexedFiles: 12,
      gitModifiedFiles: 2,
      recentSessionFiles: 3,
      recentSessionDirectories: 2,
    };
    h.rpc.mockResolvedValue(counts);
    await h.context.__tweakccFffRefresh();
    expect(h.context.__tweakccFffScope('session-one')).toBe(counts);
    expect(h.context.__tweakccFffScope('another-session')).toBeNull();
    h.context.__tweakccFffContext.time -= 40000;
    expect(h.context.__tweakccFffScope('session-one')).toBeNull();
    h.cwd('/tmp/elsewhere');
    expect(h.context.__tweakccFffScope('session-one')).toBeNull();
  });
});
