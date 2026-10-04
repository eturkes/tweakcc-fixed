import { describe, it, expect, vi } from 'vitest';
import { writeModelAtEffort } from './modelAtEffort';

// trimmed from the CC 2.1.285 /model handler: b is onDone, a is the args, and
// e(xe,{args,onDone}) is the inline setter that actually switches the model
const FIXTURE =
  'function vo(){}var xt=async(b,o,a)=>{if(a=a?.trim()||"",k2o(a))return i("tengu_model_command_inline_help",{args:a}),e(vo,{onDone:b});' +
  'if(ZC.includes(a)){b("help",{display:"system"});return}' +
  'if(a)return i("tengu_model_command_inline",{}),e(xe,{args:a,onDone:b});return e(Po,{onDone:b})};';

type Props = { args?: string; onDone: (msg?: string, opts?: object) => void };

// runs the patched handler with stubs; e() hands back the props it would render
const runModelCommand = async (args: string) => {
  const patched = writeModelAtEffort(FIXTURE);
  expect(patched).not.toBeNull();
  const makeHandler = new Function(
    'k2o',
    'i',
    'e',
    'xe',
    'Po',
    'ZC',
    `${patched}return xt;`
  );
  const xt = makeHandler(
    (a: string) => a === 'current',
    () => {},
    (_component: unknown, props: Props) => props,
    'xe',
    'Po',
    ['help']
  );
  const onDone = vi.fn();
  const props: Props = await xt(onDone, {}, args);
  return { props, onDone };
};

describe('writeModelAtEffort', () => {
  it('strips @effort and chains /effort after a successful switch', async () => {
    const { props, onDone } = await runModelCommand('opus@high');
    expect(props.args).toBe('opus');

    props.onDone('Set model to Opus');
    expect(onDone).toHaveBeenCalledWith('Set model to Opus', {
      nextInput: '/effort high',
      submitNextInput: true,
    });
  });

  it('lowercases the effort word', async () => {
    const { props, onDone } = await runModelCommand('Opus@HIGH');
    expect(props.args).toBe('Opus');

    props.onDone('ok');
    expect(onDone).toHaveBeenCalledWith('ok', {
      nextInput: '/effort high',
      submitNextInput: true,
    });
  });

  it('does not chain /effort when the switch fails or is cancelled', async () => {
    const { props, onDone } = await runModelCommand('bogus@high');

    props.onDone("Model 'bogus' not found", { display: 'system' });
    expect(onDone).toHaveBeenCalledWith("Model 'bogus' not found", {
      display: 'system',
    });
  });

  it("leaves the consent path's own nextInput alone", async () => {
    const { props, onDone } = await runModelCommand('fable@max');
    const upgrade = {
      display: 'skip',
      nextInput: '/upgrade',
      submitNextInput: true,
    };

    props.onDone(undefined, upgrade);
    expect(onDone).toHaveBeenCalledWith(undefined, upgrade);
  });

  it('keeps Vertex-style @date model IDs whole', async () => {
    const { props, onDone } = await runModelCommand('claude-opus-4-1@20250805');
    expect(props.args).toBe('claude-opus-4-1@20250805');

    props.onDone('Set model');
    expect(onDone).toHaveBeenCalledWith('Set model');
  });

  it('returns null when the /model handler is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeModelAtEffort('x=1;function y(){}')).toBeNull();
    errSpy.mockRestore();
  });
});
