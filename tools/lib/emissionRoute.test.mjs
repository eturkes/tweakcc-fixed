// Real-shape fixtures for the emission-route tracer. Each one is a minimal
// virtual bundle (modules behind the extractor's sentinels) that reproduces a
// routing shape the classify phase has got wrong or had to dig for by hand.
import { describe, it, expect } from 'vitest';
import { RouteProgram, SINKS } from './emissionRoute.mjs';

const bundle = mods =>
  '#!/usr/bin/env node\n// Virtual bundle\nvar __ccVirtualBundleModules = ' + mods.length + ';\n' +
  mods.map(([name, src], i) => `\n/*@@TWEAKCC_MODULE:${i}:/$bunfs/root/${name}@@*/\n${src}\n`).join('');

// Offset of the literal (its opening quote/backtick) that contains `text`.
const litAt = (code, text) => {
  const i = code.indexOf(text);
  if (i < 0) throw new Error(`fixture lacks ${text}`);
  let s = i;
  while (s > 0 && !['"', '`', "'"].includes(code[s - 1])) s--;
  return s - 1;
};
const trace = (code, text, opts) => new RouteProgram(code, opts).trace(litAt(code, text));
const kinds = r => r.sinks.map(s => s.kind);

const JSX = ['chunk-jsx.js', 'var v=Symbol.for("react.transitional.element");function k(o,t,s){return{$$typeof:v,type:o,key:s,ref:null,props:t}}var e=k,r=k;export{e,r};'];

describe('local command {type:"text"} results (/autocompact, CC 2.1.288)', () => {
  // A status helper builds lines with push and returns them joined; the
  // command's call() returns {type:"text",value:helper(...)}; the command
  // module re-exports call; a registry object loads the module by name.
  const code = bundle([
    ['chunk-core.js', 'function Df(){return!0}function w(a,n){let e=[`Auto-compact window for ${a}: ${n}`];if(!Df())e.push("Auto-compact is currently disabled (see /config)");e.push("Auto-compact summarizes the conversation when context usage approaches this limit."),e.push("The auto setting picks a window tuned for your model.");return e.join(`\n`)}async function gPt(a,n){if(a==="env")return"CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.";return`Auto-compact window set to ${a}`}var Ids=async(a,n)=>{let o=a.trim();if(!o)return{type:"text",value:w(n.options.mainLoopModel,n.options.autoCompactWindow)};return{type:"text",value:await gPt(o,n)}};export{gPt,Ids};'],
    ['chunk-cmd.js', 'import{gPt,Ids}from"/$bunfs/root/chunk-core.js";export{gPt as applyAutoCompactWindow,Ids as call};'],
    ['chunk-reg.js', 'var k9t={type:"local-jsx",name:"autocompact",description:"Set how full the context gets"},_fe={type:"local",name:"autocompact",description:"Configure the auto-compact window size",load:()=>import("/$bunfs/root/chunk-cmd.js")};export{k9t,_fe};'],
  ]);

  it('proves the pushed-and-joined status line model-facing', () => {
    const r = trace(code, 'Auto-compact summarizes the conversation');
    expect(r.verdict).toBe('model');
    expect(r.resolved).toBe(true);
    expect(kinds(r)).toContain('local-command-text');
  });

  it('proves a setter helper\'s returned text model-facing through the async call', () => {
    const r = trace(code, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set');
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toContain('local-command-text');
  });
});

describe('permission decisions', () => {
  it('a behavior:"ask" message is a model-facing permission message', () => {
    const code = bundle([
      ['chunk-perm.js', 'function oB(e){let n=`${e}; under the read block a command the shell parser cannot analyze asks the person`;return{behavior:"ask",message:n,decisionReason:{type:"safetyCheck",reason:n}}}export{oB};'],
    ]);
    const r = trace(code, 'a command the shell parser cannot analyze');
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toContain('permission-message');
  });
});

describe('local-jsx onDone', () => {
  const code = bundle([
    JSX,
    ['chunk-brief.js', 'async function p(s,o,n){if(n==="on")s("Brief mode is on.",{display:"system",metaMessages:["The user turned brief mode on; keep every reply to one short paragraph."]});else s("Brief mode stays as it was.");return null}export{p as call};'],
    ['chunk-plug.js', 'import{e}from"/$bunfs/root/chunk-jsx.js";function Mt({onComplete:a,args:b}){a(`Plugin ${b} was not found in any configured marketplace.`);return null}async function p(s,o,n){return e(Mt,{onComplete:s,args:n})}export{p as call};'],
    ['chunk-reg.js', 'var r={brief:()=>import("/$bunfs/root/chunk-brief.js"),plugin:()=>import("/$bunfs/root/chunk-plug.js"),help:()=>import("/$bunfs/root/chunk-help.js")};var a={type:"local-jsx",name:"brief",description:"Toggle brief mode"},b={type:"local-jsx",name:"plugin",description:"Manage plugins"},c={type:"local-jsx",name:"help",description:"Help"};export{r,a,b,c};'],
    ['chunk-help.js', 'function p(s){return null}export{p as call};'],
  ]);

  it('display:"system" keeps the value off the wire but metaMessages still reach the model', () => {
    const sys = trace(code, 'Brief mode is on.');
    expect(kinds(sys)).toEqual(['local-jsx-system']);
    expect(sys.verdict).toBe('ui');
    const meta = trace(code, 'keep every reply to one short paragraph');
    expect(meta.verdict).toBe('model');
    expect(kinds(meta)).toContain('local-jsx-meta');
  });

  it('an onDone value without display options is model-facing', () => {
    const r = trace(code, 'Brief mode stays as it was.');
    expect(r.verdict).toBe('model');
    expect(r.sinks.find(s => s.kind === 'local-jsx-ondone').command).toBe('brief');
  });

  it('follows onDone passed into a component as a prop (registry-loaded command)', () => {
    const r = trace(code, 'was not found in any configured marketplace');
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toContain('local-jsx-ondone');
  });
});

describe('zod .describe roots', () => {
  const zod = ['chunk-zod.js', 'class ZodError extends Error{}function u(e){return{shape:e,describe(d){return this},optional(){return this}}}function o(){return{describe(d){return this},optional(){return this}}}function R(v){return{literal:v}}export{u,o,R,ZodError};'];

  it('a settings-schema description is model-facing (settings index supplied)', () => {
    const code = bundle([zod, ['chunk-set.js', 'import{u,o}from"/$bunfs/root/chunk-zod.js";var S=u({cleanupPeriodDays:o().optional().describe("Number of days to retain chat transcripts locally (default: 30).")});export{S};']]);
    const at = litAt(code, 'Number of days to retain');
    const r = new RouteProgram(code, { settingsIndex: new Map([[at, { internal: false }]]) }).trace(at);
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toEqual(['settings-describe']);
  });

  it('an SDK control-schema description is internal', () => {
    const code = bundle([zod, ['chunk-sdk.js', 'import{u,o,R}from"/$bunfs/root/chunk-zod.js";var q=u({subtype:R("interrupt"),reason:o().describe("Why the host interrupted the turn, for its own logs.")});export{q};']]);
    const r = trace(code, 'Why the host interrupted the turn');
    expect(kinds(r)).toContain('sdk-control-schema');
    expect(r.verdict).toBe('internal');
  });

  it('a tool input-schema description and the tool prompt are model-facing', () => {
    const code = bundle([zod, ['chunk-tool.js', 'import{u,o}from"/$bunfs/root/chunk-zod.js";var T={name:"ReadThing",inputSchema:u({path:o().describe("Absolute path of the thing to read.")}),async call(e){return{data:e}},async prompt(){return"Reads one thing from the local disk and returns its text."},mapToolResultToToolResultBlockParam(e,n){return{tool_use_id:n,type:"tool_result",content:String(e)}}};export{T};']]);
    expect(kinds(trace(code, 'Absolute path of the thing to read.'))).toContain('tool-input-schema');
    const p = trace(code, 'Reads one thing from the local disk');
    expect(p.verdict).toBe('model');
    expect(kinds(p)).toContain('tool-prompt');
  });
});

describe('UI and internal sinks', () => {
  it('an Ink children string is ui and resolved', () => {
    const code = bundle([JSX, ['chunk-ui.js', 'import{e}from"/$bunfs/root/chunk-jsx.js";function Text(t){return e("ink-text",t)}function V(){return e(Text,{dimColor:!0,children:"Press enter to continue the setup wizard"})}export{V,Text};']]);
    const r = trace(code, 'Press enter to continue');
    expect(r.verdict).toBe('ui');
    expect(r.resolved).toBe(true);
    expect(kinds(r)).toEqual(['jsx-children']);
  });

  it('a debug-log line is internal, recognised through a re-exported logger name', () => {
    const code = bundle([
      ['chunk-log.js', 'function t(e,n){process.stderr.write(e)}export{t};'],
      ['chunk-dbg.js', 'import{t}from"/$bunfs/root/chunk-log.js";export{t as logForDebugging};'],
      ['chunk-use.js', 'import{t as h}from"/$bunfs/root/chunk-log.js";function q(e){h(`Policy limits: stamp unreadable (${e}); cache reads as unvouched`,{level:"warn"})}export{q};'],
    ]);
    const r = trace(code, 'Policy limits: stamp unreadable');
    expect(r.verdict).toBe('internal');
    expect(kinds(r)).toEqual(['debug-log']);
  });

  it('a UI route never cancels a proven model route', () => {
    const code = bundle([['chunk-both.js', 'function f(m){console.error(m);return[{type:"text",text:m}]}function g(){return f("The export was written to the requested folder.")}export{g};']]);
    const r = trace(code, 'The export was written');
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toEqual(expect.arrayContaining(['console', 'text-block']));
  });
});

describe('exceptions and tool results', () => {
  it('an error thrown below a tool call() becomes a model-facing tool error', () => {
    const code = bundle([['chunk-t.js', 'function f(e){if(e>1e6)throw Error("The file is too large to read in one call.");return e}var T={name:"Read",inputSchema:{},async call(e){return{data:f(e.size)}},async prompt(){return"Read a file."},mapToolResultToToolResultBlockParam(e,n){return{tool_use_id:n,type:"tool_result",content:String(e)}}};export{T};']]);
    const r = trace(code, 'The file is too large to read');
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toContain('tool-throw');
  });

  it('a caught error only reaches what the catch block does with it', () => {
    const code = bundle([['chunk-c.js', 'function f(){throw Error("Marketplace cache folder is unreadable right now.")}function g(){try{f()}catch(e){console.error(e.message)}}export{g};']]);
    const r = trace(code, 'Marketplace cache folder is unreadable');
    expect(kinds(r)).toEqual(['console']);
    // process output settles nothing on its own: the model may run this
    // entry point through Bash.
    expect(SINKS.console.facing).toBe(null);
    expect(r.verdict).toBe(null);
  });

  it('tool call data reaches the model only through the mapper', () => {
    const code = bundle([['chunk-d.js', 'var T={name:"Send",inputSchema:{},async call(e){return{data:{message:e.m,note:"Delivered to the user\'s phone and desktop."}}},async prompt(){return"Send."},mapToolResultToToolResultBlockParam(e,n){return{tool_use_id:n,type:"tool_result",content:`Message delivered. ${e.note}`}}};export{T};']]);
    const r = trace(code, 'Delivered to the user');
    expect(r.verdict).toBe('model');
    expect(kinds(r)).toContain('tool-result-content');
  });
});

describe('conservatism', () => {
  it('a call through an unresolvable callback is open, not silently dead', () => {
    const code = bundle([['chunk-u.js', 'function g(cb){cb("A dynamic message nobody can statically follow.")}export{g};']]);
    const r = trace(code, 'A dynamic message nobody');
    expect(r.verdict).toBe(null);
    expect(r.resolved).toBe(false);
    expect(r.unresolved.length).toBeGreaterThan(0);
  });

  it('a value that is never emitted is not reported as resolved', () => {
    const code = bundle([['chunk-n.js', 'function g(){let a="This sentence is built and then dropped on the floor.";return 1}export{g};']]);
    const r = trace(code, 'This sentence is built');
    expect(r.resolved).toBe(false);
    expect(r.verdict).toBe(null);
  });

  it('an instanceof guard the error class fails stops the branch', () => {
    const code = bundle([['chunk-g.js', 'class A extends Error{}class B extends Error{}function f(){throw new A("Only the A failure should be reported to the model here.")}function g(){let m;try{f()}catch(e){if(e instanceof B)m=e.message}return[{type:"text",text:m}]}export{g};']]);
    const r = trace(code, 'Only the A failure');
    expect(r.verdict).not.toBe('model');
  });

  it('a summary round-trips: the offline program answers from the memo', () => {
    const code = bundle([['chunk-o.js', 'function oB(e){return{behavior:"deny",message:"Denied because the path is outside the project."}}export{oB};']]);
    const p = new RouteProgram(code);
    const at = litAt(code, 'Denied because the path');
    const live = p.trace(at);
    const offline = RouteProgram.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
    expect(offline.offline).toBe(true);
    expect(offline.trace(at)).toEqual(live);
  });
});
