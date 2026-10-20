export const buildFffContextRuntime = (): string =>
  'globalThis.__tweakccFffBind??=((sid,cwdFn)=>{' +
  'if(typeof sid!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(sid))return;' +
  'let state=globalThis.__tweakccFffContext;' +
  'if(!state||state.sid!==sid)state=globalThis.__tweakccFffContext={sid};state.cwdFn=cwdFn;});' +
  'globalThis.__tweakccFffCwd??=(()=>{try{let cwd=globalThis.__tweakccFffContext?.cwdFn?.();if(typeof cwd==="string"&&cwd)return cwd;}catch{}return process.cwd();});';

export const bindFffSession = (file: string): string | null => {
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
    `try{if(!${state}.agentId){${buildFffContextRuntime()}` +
    `globalThis.__tweakccFffBind(${state}.session?.id,()=>${state}.session?.project?.cwd);}}catch(__tweakccFffError){}`;
  return file.slice(0, at) + runtime + file.slice(at);
};
