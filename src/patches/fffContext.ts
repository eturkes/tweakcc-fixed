import { escapeNonAscii } from '../utils';

export const buildFffContextRuntime = (wrapperPath: string): string => {
  const wrapper = escapeNonAscii(JSON.stringify(wrapperPath));
  return (
    'globalThis.__tweakccFffBind??=((sid,cwdFn)=>{' +
    'if(typeof sid!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(sid))return;' +
    'let state=globalThis.__tweakccFffContext;' +
    'if(!state||state.sid!==sid)state=globalThis.__tweakccFffContext={sid,scope:null,time:0,pending:false};state.cwdFn=cwdFn;});' +
    'globalThis.__tweakccFffCwd??=(()=>{try{let cwd=globalThis.__tweakccFffContext?.cwdFn?.();if(typeof cwd==="string"&&cwd)return cwd;}catch{}return process.cwd();});' +
    'globalThis.__tweakccFffExec??=(async(args,timeout=250,cwd=globalThis.__tweakccFffCwd())=>{' +
    'try{let{execFile}=await import("node:child_process");return await new Promise(resolve=>{' +
    `let child=execFile(${wrapper},args,` +
    '{cwd,encoding:"utf8",timeout,maxBuffer:65536,windowsHide:true},(error,stdout)=>{' +
    'if(error){resolve(null);return;}try{resolve(JSON.parse(stdout));}catch{resolve(null);}});child.unref();});' +
    '}catch{return null;}});' +
    'globalThis.__tweakccFffRefresh??=(async(force=false)=>{' +
    'let state=globalThis.__tweakccFffContext,cwd=globalThis.__tweakccFffCwd();' +
    'if(!state||state.pending||!force&&Date.now()-state.time<10000&&state.cwd===cwd)return;' +
    'state.pending=true;let scope=await globalThis.__tweakccFffExec(["--scope",state.sid],250,cwd);' +
    'state.pending=false;if(state!==globalThis.__tweakccFffContext||cwd!==globalThis.__tweakccFffCwd())return;' +
    'state.scope=scope;state.cwd=cwd;state.time=Date.now();});' +
    'globalThis.__tweakccFffScope??=((sid)=>{' +
    'let state=globalThis.__tweakccFffContext;globalThis.__tweakccFffRefresh();' +
    'if(!state||state.sid!==sid||state.cwd!==globalThis.__tweakccFffCwd()||Date.now()-state.time>30000)return null;' +
    'return state.scope;});' +
    'globalThis.__tweakccFffCompact??=(async(summary,context)=>{' +
    'if(typeof summary!=="string"||summary.includes("[fff navigation pointers]"))return summary;' +
    'let state=globalThis.__tweakccFffContext,cwd=context?.session?.project?.cwd;' +
    'if(!state||context?.agentId||context?.session?.id!==state.sid||typeof cwd!=="string"||cwd!==globalThis.__tweakccFffCwd())return summary;' +
    'let paths=await globalThis.__tweakccFffExec(["--context",state.sid],250,cwd);' +
    'if(state!==globalThis.__tweakccFffContext||context.agentId||context.session.id!==state.sid||cwd!==globalThis.__tweakccFffCwd()||cwd!==context.session.project.cwd||!Array.isArray(paths))return summary;' +
    'paths=paths.filter(path=>typeof path==="string"&&path.length<=240&&!/^[\\/]|[\\x00-\\x1f\\x7f]/.test(path)&&!path.split(/[\\/]/).includes("..")).slice(0,8);' +
    'if(!paths.length)return summary;' +
    'let note="\\n\\n[fff navigation pointers]\\nRecent files used in this session and directory, ranked by file usage. Paths are navigation hints; read files to verify current content.\\n";for(let path of paths){let line=JSON.stringify(path)+"\\n";if(note.length+line.length>2048)break;note+=line;}' +
    'return summary+note;});'
  );
};

export const bindFffSession = (
  file: string,
  wrapperPath: string
): string | null => {
  if (file.includes('globalThis.__tweakccFffBind(')) return file;
  const match = file.match(
    /if\(([$\w]+)===null&&([$\w]+)!=="prompt"\)throw Error\(`Mode: \$\{\2\} requires a string input\.`\);/
  );
  if (match?.index === undefined) return null;
  const before = file.slice(Math.max(0, match.index - 4000), match.index);
  const state = [...before.matchAll(/([$\w]+)\.options\.mainLoopModel/g)].at(
    -1
  )?.[1];
  if (!state) return null;
  const at = match.index + match[0].length;
  const runtime =
    `try{if(!${state}.agentId){${buildFffContextRuntime(wrapperPath)}` +
    `globalThis.__tweakccFffBind(${state}.session?.id,()=>${state}.session?.project?.cwd);globalThis.__tweakccFffRefresh();}}catch(__tweakccFffError){}`;
  return file.slice(0, at) + runtime + file.slice(at);
};

export const attachFffCompaction = (file: string): string | null => {
  if (file.includes('await globalThis.__tweakccFffCompact(')) return file;
  const marker =
    'Reactive compact: empty summary text in summarization response';
  const index = file.indexOf(marker);
  if (index < 0) return null;
  const before = file.slice(Math.max(0, index - 5000), index);
  const enclosing = [
    ...before.matchAll(
      /async function [$\w]+\(([^)]*)\)\{let [$\w]+=[$\w]+\(\),[$\w]+=[$\w]+\(([$\w]+)\.toolUseContext\),/g
    ),
  ].at(-1);
  if (!enclosing || !enclosing[1].split(',').includes(enclosing[2]))
    return null;
  const prefix = file.slice(Math.max(0, index - 250), index);
  const summary = prefix.match(
    /let ([$\w]+)=[$\w]+\([$\w]+\.messages\);if\(!\1\)return/
  );
  const tail = file.slice(index, index + 2000);
  const success = tail.match(/;let [$\w]+;return/);
  if (
    !summary ||
    success?.index === undefined ||
    !tail.includes(`summaryText:${summary[1]},`)
  )
    return null;
  const at = index + success.index + 1;
  const text = `try{if(typeof globalThis.__tweakccFffCompact==="function")${summary[1]}=await globalThis.__tweakccFffCompact(${summary[1]},${enclosing[2]}.toolUseContext);}catch(__tweakccFffError){}`;
  return file.slice(0, at) + text + file.slice(at);
};
