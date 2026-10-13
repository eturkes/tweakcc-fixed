import { parseExpressionAt } from 'acorn';

export function diversifyNativeSearchLines(lines, context) {
  const files = new Map();
  let separated = true;
  let previousPath = '';
  for (const line of lines) {
    if (line === '--') {
      separated = true;
      continue;
    }
    const split = line.indexOf('\0');
    const number = /^(\d+)([:-])/.exec(line.slice(split + 1));
    if (split <= 0 || !number || line.indexOf('\0', split + 1) !== -1)
      return lines;
    const path = line.slice(0, split);
    const index = Number(number[1]);
    if (!Number.isSafeInteger(index) || index < 1) return lines;
    let file = files.get(path);
    if (!file) {
      file = { chunks: [], lastLine: -1, offset: 0 };
      files.set(path, file);
    }
    if (index <= file.lastLine) return lines;
    let chunk = file.chunks.at(-1);
    if (
      !chunk ||
      !context ||
      separated ||
      path !== previousPath ||
      (context && index !== file.lastLine + 1)
    ) {
      chunk = [];
      file.chunks.push(chunk);
    }
    chunk.push(line);
    file.lastLine = index;
    previousPath = path;
    separated = false;
  }
  if (files.size < 2) return lines;
  const result = [];
  let active = Array.from(files.values());
  while (active.length) {
    const next = [];
    for (const file of active) {
      const chunk = file.chunks[file.offset++];
      if (context && result.length) result.push('--');
      for (const line of chunk) result.push(line);
      if (file.offset < file.chunks.length) next.push(file);
    }
    active = next;
  }
  return result.length === lines.length ? result : lines;
}

export const writeNativeSearchResults = file => {
  if (file.includes('var __tweakccNativeSearchOrder=')) return file;
  const headers = [
    ...file.matchAll(
      /async function [$\w]+\(([$\w]+),\{(pattern:[$\w]+,glob:[^}]{1,1500})\},[$\w]+\)\{/g
    ),
  ];
  const candidates = headers.flatMap(header => {
    const field = key => header[2].match(new RegExp(`${key}:([$\\w]+)`))?.[1];
    const mode = field('output_mode');
    const limit = field('head_limit');
    const multiline = field('multiline');
    const onlyMatching = field('"-o"');
    const contexts = ['context', '"-C"', '"-B"', '"-A"'].map(field);
    if (
      !mode ||
      !limit ||
      !multiline ||
      !onlyMatching ||
      contexts.some(value => !value)
    )
      return [];
    let fn;
    try {
      fn = parseExpressionAt(file, header.index, {
        ecmaVersion: 'latest',
        sourceType: 'module',
      });
    } catch {
      return [];
    }
    if (fn.type !== 'FunctionExpression') return [];
    const start = header.index + header[0].length;
    const body = file.slice(start, fn.end);
    const boundary = new RegExp(
      `if\\(${mode.replaceAll('$', '\\$')}==="content"\\)\\{let\\{items:[$\\w]+,appliedLimit:[$\\w]+\\}=[$\\w]+\\(([$\\w]+),${limit.replaceAll('$', '\\$')},[$\\w]+\\)`
    ).exec(body);
    if (
      !boundary ||
      !fn.body.body.some(
        statement => statement.start === start + boundary.index
      ) ||
      !body
        .slice(boundary.index, boundary.index + 2000)
        .includes(`totalLines:${boundary[1]}.length`) ||
      !body.slice(0, boundary.index).includes('beforeSpawn:')
    )
      return [];
    return [
      {
        at: start + boundary.index,
        lines: boundary[1],
        target: header[1],
        mode,
        limit,
        multiline,
        onlyMatching,
        contexts,
      },
    ];
  });
  if (candidates.length !== 1) {
    console.error(
      'patch: nativeSearchResults: failed to find unique post-permission Grep result boundary'
    );
    return null;
  }
  const match = candidates[0];
  const runtime =
    `var __tweakccNativeSearchOrder=${diversifyNativeSearchLines.toString()};` +
    `if(${match.mode}==="content"&&${match.target}.isDirectory&&!${match.multiline}&&!${match.onlyMatching})` +
    `${match.lines}=__tweakccNativeSearchOrder(${match.lines},[${match.contexts.join(',')}].some(value=>typeof value==="number"&&value>0));`;
  const updated = file.slice(0, match.at) + runtime + file.slice(match.at);
  return updated;
};
