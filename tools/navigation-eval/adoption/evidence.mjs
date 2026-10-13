import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { visibleLocations } from '../core.mjs';

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).join('\n');
  if (typeof content?.text === 'string') return content.text;
  return JSON.stringify(content ?? '');
}

export function parseEvents(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function tokens(command) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import json,shlex,sys\nlexer=shlex.shlex(sys.stdin.read(),posix=True,punctuation_chars=True)\nlexer.whitespace_split=True\nlexer.commenters=""\nprint(json.dumps(list(lexer)))',
    ],
    { input: command, encoding: 'utf8', timeout: 5000 }
  );
  if (result.status !== 0) return [];
  return JSON.parse(result.stdout);
}

function within(corpus, value) {
  const name = relative(corpus, value);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('../');
}

function viewerOperands(command, initialCwd, corpus) {
  let cwd = initialCwd;
  const words = tokens(command);
  const variables = new Map();
  const operands = new Set();
  for (let index = 0; index < words.length; index++) {
    if (words[index] === 'for' && words[index + 2] === 'in') {
      const end = words.findIndex(
        (word, position) => position > index && word === ';'
      );
      if (end > index)
        variables.set(words[index + 1], words.slice(index + 3, end));
    }
  }
  const segments = [];
  let segment = [];
  for (const word of words) {
    if (/^(?:;|&&|\|\||\||>|<|>>|<<|\(|\))$/.test(word)) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(word);
  }
  if (segment.length) segments.push(segment);
  for (const original of segments) {
    const row = [...original];
    while (['do', 'then', 'command', 'builtin'].includes(row[0])) row.shift();
    if (row[0] === 'cd' && row[1] && cwd) {
      const destination = resolve(cwd, row[1]);
      try {
        if (within(corpus, destination) && statSync(destination).isDirectory())
          cwd = destination;
      } catch {
        continue;
      }
      continue;
    }
    const viewer = basename(row[0] ?? '');
    if (!cwd || !['cat', 'head', 'tail', 'sed', 'nl'].includes(viewer))
      continue;
    const arguments_ = row.slice(1);
    let skipValue = false;
    let sedExpression = viewer === 'sed';
    for (const word of arguments_) {
      if (skipValue) {
        skipValue = false;
        continue;
      }
      if (word.startsWith('-')) {
        if (['-n', '-c'].includes(word) && ['head', 'tail'].includes(viewer))
          skipValue = true;
        if (['-b', '-w', '-s'].includes(word) && viewer === 'nl')
          skipValue = true;
        if (['-e', '-f'].includes(word) && viewer === 'sed') skipValue = true;
        continue;
      }
      if (sedExpression) {
        sedExpression = false;
        continue;
      }
      const variable = /^\$\{?(\w+)\}?$/.exec(word);
      const values = variable ? (variables.get(variable[1]) ?? []) : [word];
      for (const value of values) {
        const file = resolve(cwd, value);
        try {
          if (within(corpus, file) && statSync(file).isFile())
            operands.add(relative(corpus, file));
        } catch {
          continue;
        }
      }
    }
  }
  return { operands: [...operands], cwd };
}

const informative = line => line.trim().length >= 12 && /[A-Za-z_]/.test(line);

function viewerEvidence(text, paths, corpus) {
  const source = paths.map(name => ({
    name,
    lines: readFileSync(join(corpus, name), 'utf8').split('\n'),
  }));
  const evidence = [];
  for (const row of text.split('\n')) {
    const numbered = /^\s*(\d+)(?:\s*→\s*|\t)(.*)$/.exec(row);
    const value = (numbered?.[2] ?? row).trim();
    if (!informative(value)) continue;
    const matches = source.flatMap(file =>
      file.lines.flatMap((line, index) => {
        if (
          line.trim() !== value ||
          (numbered && Number(numbered[1]) !== index + 1)
        )
          return [];
        return [{ path: file.name, line: index + 1, text: line }];
      })
    );
    if (matches.length === 1) evidence.push(matches[0]);
  }
  return evidence;
}

export function inspectEvidence(events, corpus, requiredFiles = []) {
  const calls = events.flatMap((event, eventIndex) =>
    event.type === 'assistant'
      ? (event.message?.content ?? [])
          .filter(block => block.type === 'tool_use')
          .map(({ id, name, input }) => ({
            id,
            name,
            input,
            eventIndex,
            agentId: event.agent_id ?? null,
            parentToolUseId: event.parent_tool_use_id ?? null,
            subagentType: event.subagent_type ?? null,
          }))
      : []
  );
  const results = events.flatMap((event, eventIndex) =>
    event.type === 'user'
      ? (event.message?.content ?? [])
          .filter(block => block.type === 'tool_result')
          .map(block => ({
            id: block.tool_use_id,
            isError: block.is_error ?? false,
            content: block.content,
            eventIndex,
            agentId: event.agent_id ?? null,
            parentToolUseId: event.parent_tool_use_id ?? null,
            subagentType: event.subagent_type ?? null,
          }))
      : []
  );
  const byId = new Map(results.map(result => [result.id, result]));
  const locations = [];
  const bashCwds = new Map();
  for (const call of calls) {
    const result = byId.get(call.id);
    if (!result || result.isError) continue;
    const text = contentText(result.content);
    if (call.name === 'Read') {
      const file = resolve(corpus, call.input.file_path ?? '');
      if (within(corpus, file)) {
        for (const location of viewerEvidence(
          text,
          [relative(corpus, file)],
          corpus
        ))
          locations.push({
            ...location,
            toolUseId: call.id,
            kind: 'Read',
            agentId: call.agentId,
            parentToolUseId: call.parentToolUseId,
          });
      }
    } else if (call.name === 'Grep') {
      for (const location of visibleLocations(text, corpus).entries) {
        const source = readFileSync(join(corpus, location.path), 'utf8').split(
          '\n'
        );
        if (
          informative(location.text ?? '') &&
          source[location.line - 1]?.trim() === location.text.trim()
        )
          locations.push({
            ...location,
            toolUseId: call.id,
            kind: 'Grep',
            agentId: call.agentId,
            parentToolUseId: call.parentToolUseId,
          });
      }
    } else if (call.name === 'Bash') {
      const viewed = viewerOperands(
        call.input.command ?? '',
        bashCwds.get(call.agentId) ?? corpus,
        corpus
      );
      bashCwds.set(call.agentId, viewed.cwd);
      for (const location of viewerEvidence(text, viewed.operands, corpus))
        locations.push({
          ...location,
          toolUseId: call.id,
          kind: 'Bash viewer',
          agentId: call.agentId,
          parentToolUseId: call.parentToolUseId,
        });
    }
  }
  const fff = calls
    .filter(
      call =>
        call.name === 'Bash' &&
        /(?:^|[\s;&|()])fff\s+files(?:\s|$)/.test(call.input.command ?? '')
    )
    .map(call => {
      const result = byId.get(call.id);
      const text = contentText(result?.content);
      const candidates = text.split('\n').flatMap(line => {
        const match =
          /^(.*?)\s*(?:\[modified\]\s*)?->\s*(?:Read|browse)\s*$/.exec(line);
        return match
          ? [match[1].replace(/\s*\[modified\]\s*$/, '').trim()]
          : [];
      });
      const laterIds = new Set(
        calls
          .filter(later => later.eventIndex > (result?.eventIndex ?? Infinity))
          .map(later => later.id)
      );
      const inspected = locations.filter(
        location =>
          candidates.includes(location.path) && laterIds.has(location.toolUseId)
      );
      return {
        id: call.id,
        command: call.input.command,
        agentId: call.agentId,
        parentToolUseId: call.parentToolUseId,
        isError: result?.isError ?? null,
        successfulHeader:
          result?.isError === false &&
          text.includes(
            '# fff: ranked fuzzy filenames; verify candidate files by reading them'
          ),
        candidates,
        inspectedCandidatePaths: [
          ...new Set(inspected.map(location => location.path)),
        ],
        inspectedSameAgentCandidatePaths: [
          ...new Set(
            inspected
              .filter(location => location.agentId === call.agentId)
              .map(location => location.path)
          ),
        ],
      };
    });
  return {
    calls,
    results,
    fff,
    locations,
    requiredFiles: requiredFiles.map(file => ({
      file,
      evidence: locations.filter(location => location.path === file),
    })),
  };
}
