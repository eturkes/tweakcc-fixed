import { escapeNonAscii } from '../utils';

export const buildFffUsageRuntime = (wrapperPath: string): string => {
  const wrapper = escapeNonAscii(JSON.stringify(wrapperPath));
  return (
    'globalThis.__tweakccFffRecord??=((operation,filePath)=>{' +
    'if(!["read","edit","write"].includes(operation)||typeof filePath!=="string")return;' +
    'Promise.resolve().then(()=>import("node:child_process")).then(({spawn})=>{' +
    `let child=spawn(${wrapper},["--record-access",filePath,String(process.pid)],` +
    '{cwd:process.cwd(),stdio:"ignore",windowsHide:true});' +
    'child.on("error",()=>{});child.unref();' +
    '}).catch(()=>{});});'
  );
};

export const observeFffFileUsage = (
  file: string,
  wrapperPath: string
): string | null => {
  if (file.includes('globalThis.__tweakccFffRecord??=')) return file;
  const pattern =
    /function ([$\w]+)\(([$\w]+)\)\{(?=let [$\w]+=\{operation:[$\w]+\(\2\.operation\),tool:[$\w]+\(\2\.tool\),filePathHash:[$\w]+\(\2\.filePath\)\})/;
  const match = file.match(pattern);
  if (match?.index === undefined) return null;
  const start = match.index + match[0].length;
  const notification =
    `try{${buildFffUsageRuntime(wrapperPath)}` +
    `globalThis.__tweakccFffRecord(${match[2]}.operation,${match[2]}.filePath);}` +
    'catch(__tweakccFffError){}';
  return file.slice(0, start) + notification + file.slice(start);
};

export const buildFffAutocompleteRuntime = (wrapperPath: string): string => {
  const wrapper = escapeNonAscii(JSON.stringify(wrapperPath));
  return (
    'globalThis.__tweakccFffFiles??=(async(query,cwd,limit,base)=>{' +
    'if(typeof query!=="string"||query.length>4096)return[];' +
    'try{let[{execFile},path]=await Promise.all([import("node:child_process"),import("node:path")]);' +
    'let items=await new Promise(resolve=>{' +
    `execFile(${wrapper},["--suggest",query,String(Math.min(100,limit))],` +
    '{cwd,encoding:"utf8",timeout:250,maxBuffer:65536,windowsHide:true},(error,stdout)=>{' +
    'if(error){resolve([]);return;}try{let parsed=JSON.parse(stdout);resolve(Array.isArray(parsed)?parsed:[]);}catch{resolve([]);}});});' +
    'return items.filter(item=>typeof item.path==="string"&&Number.isFinite(item.score)&&!path.isAbsolute(item.path)&&!item.path.split(/[\\/]/).includes(".."))' +
    '.map(item=>({path:path.relative(base,path.resolve(cwd,item.path))+(item.directory?"/":""),score:item.score}));' +
    '}catch{return[];}});' +
    'globalThis.__tweakccFffMerge??=((native,extra,limit,query)=>{' +
    'let merged=new Map(native.map(item=>[item.displayText,item]));' +
    'for(let item of extra){if(merged.get(item.displayText)?.displayText===query)continue;merged.set(item.displayText,item);}' +
    'return Array.from(merged.values()).sort((a,b)=>(a.metadata?.score??1)-(b.metadata?.score??1)).slice(0,limit);});'
  );
};

export const useFffAutocomplete = (
  file: string,
  wrapperPath: string
): string | null => {
  if (file.includes('globalThis.__tweakccFffFiles??=')) return file;
  const pattern =
    /let ([$\w]+)=([$\w]+)\.fileIndex\?\2\.fileIndex\.search\(([$\w]+),([$\w]+)\)\.map\(\(([$\w]+)\)=>\s*([$\w]+)\(\5\.path,\5\.score\)\):\[\],([$\w]+)=\2\.indexBaseDir\?\?([$\w]+),/;
  const match = file.match(pattern);
  if (match?.index === undefined) return null;
  const [original, items, state, query, limit, , makeItem, , cwd] = match;
  const replacement =
    buildFffAutocompleteRuntime(wrapperPath) +
    original.slice(0, -1) +
    `,__tweakccFffExtra=await globalThis.__tweakccFffFiles(${query},${cwd},${limit},${state}.indexBaseDir??${cwd});` +
    `${items}=globalThis.__tweakccFffMerge(${items},__tweakccFffExtra.map(item=>${makeItem}(item.path,item.score)),${limit},${query});let `;
  return (
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + original.length)
  );
};
