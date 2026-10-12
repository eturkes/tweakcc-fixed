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
