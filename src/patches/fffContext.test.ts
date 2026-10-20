import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { bindFffSession, buildFffContextRuntime } from './fffContext';

const source =
  'async function submit(e,t,n,r){let model=r.options.mainLoopModel,E=e;' +
  'if(E===null&&t!=="prompt")throw Error(`Mode: ${t} requires a string input.`);' +
  'return model}';

function harness() {
  const context = vm.createContext({ process: { cwd: () => '/tmp/startup' } });
  vm.runInContext(buildFffContextRuntime(), context);
  return context;
}

describe('fff file history session', () => {
  it('binds main-session submissions without replacing subagent state', async () => {
    const patched = bindFffSession(source)!;
    expect(bindFffSession(patched)).toBe(patched);
    expect(bindFffSession('unrelated')).toBeNull();
    const context = harness();
    vm.runInContext(patched, context);
    const session = { id: 'session-one', project: { cwd: '/tmp/project' } };
    const state = { options: { mainLoopModel: 'model' }, session };
    expect(await context.submit('task', 'prompt', null, state)).toBe('model');
    expect(context.__tweakccFffContext.sid).toBe('session-one');
    expect(context.__tweakccFffCwd()).toBe('/tmp/project');
    session.project.cwd = '/tmp/project/nested';
    expect(context.__tweakccFffCwd()).toBe('/tmp/project/nested');
    await context.submit('task', 'prompt', null, {
      ...state,
      agentId: 'agent',
      session: { id: 'sub-session', project: { cwd: '/tmp/other' } },
    });
    expect(context.__tweakccFffContext.sid).toBe('session-one');
    expect(context.__tweakccFffCwd()).toBe('/tmp/project/nested');
  });

  it('uses the process cwd only when the live session cwd is unavailable', () => {
    const context = harness();
    expect(context.__tweakccFffCwd()).toBe('/tmp/startup');
    context.__tweakccFffBind('one', () => '/tmp/one');
    expect(context.__tweakccFffCwd()).toBe('/tmp/one');
    context.__tweakccFffBind('two', () => {
      throw Error('unavailable');
    });
    expect(context.__tweakccFffContext.sid).toBe('two');
    expect(context.__tweakccFffCwd()).toBe('/tmp/startup');
    for (const invalid of ['', '../foreign', 'a'.repeat(129), null]) {
      context.__tweakccFffBind(invalid, () => '/tmp/invalid');
      expect(context.__tweakccFffContext.sid).toBe('two');
    }
  });
});
