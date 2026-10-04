// Conservative emission-route tracer for the classify phase.
//
// A candidate string's facing is decided by where its VALUE goes, not by its
// wording: the same sentence can be a tool_result the model reads or an Ink
// line only a human sees. Classify agents used to answer that by writing one
// ad-hoc python probe per candidate, each reloading the 40 MB bundle. This
// builds the answer once per bundle.
//
// Shape of the analysis:
//   - every module of the virtual bundle is parsed with acorn and scoped with
//     eslint-scope on first touch (lazily, LRU-cached), so ASTs never all live
//     in memory at once;
//   - for each value-carrying point (a literal, a binding, a parameter, a call
//     result, a function value) a module-local walk up the AST produces
//     OUTCOMES: a sink, a hand-off to another point (binding, parameter, call
//     site, export) with the path operations applied on the way, or an explicit
//     "unresolved" with its reason. Those outcome lists are the data-flow
//     summary; they are memoised and serialisable, so a later query never has
//     to touch the bundle;
//   - a query walks the outcome graph from a literal with a call-site stack
//     (a value that enters a helper through an argument returns only to that
//     call, never to every caller of the helper) and a property path (a string
//     stored under `value` of `{type:"text",value}` is told apart from one
//     under `type`).
//
// It is conservative by construction: depth or budget exhaustion, a call
// through anything that is not a provable function binding, and any parent
// shape it does not model all surface as `unresolved` with the reason, never
// as a silent dead end. A proven model sink makes the route model-facing even
// when other branches are UI or unresolved; a UI sink never cancels it.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const eslintScope = require('eslint-scope');
const { splitModuleBundle } = require('./moduleBundle.cjs');

export const SUMMARY_FORMAT = 3;

// ---------------------------------------------------------------------------
// Sink vocabulary. `facing` is what the sink proves on its own; null means the
// sink is real but does not settle facing (the agent must look).
export const SINKS = Object.assign(Object.create(null), {
  'text-block': { facing: 'model', note: 'API content block {type:"text",text}' },
  'local-command-text': { facing: 'model', note: 'local command result {type:"text",value} becomes the command output the model reads' },
  'tool-result-content': { facing: 'model', note: '{type:"tool_result",content}' },
  'permission-message': { facing: 'model', note: '{behavior:"ask"|"deny",message} becomes the tool_result when the call does not run' },
  'api-message': { facing: 'model', note: '{role,content} API message' },
  'meta-message': { facing: 'model', note: '{content,isMeta} meta message sent to the model' },
  'tool-prompt': { facing: 'model', note: 'returned from a tool object\'s prompt()/description()' },
  'tool-result-mapper': { facing: 'model', note: 'returned from mapToolResultToToolResultBlockParam' },
  'tool-validate': { facing: 'model', note: 'returned from a tool\'s validateInput (the failure message is the tool_result)' },
  'tool-throw': { facing: 'model', note: 'thrown inside a tool\'s call/validateInput; the error message becomes the tool_result' },
  'command-prompt': { facing: 'model', note: 'returned from a prompt command\'s getPromptForCommand' },
  'local-jsx-ondone': { facing: 'model', note: 'first argument of a local-jsx onDone without display:"skip"/"system" — wrapped in <local-command-stdout> as a user message' },
  'local-jsx-meta': { facing: 'model', note: 'metaMessages of a local-jsx onDone reach the model on every branch but skip' },
  'tool-input-schema': { facing: 'model', note: 'zod .describe inside a tool inputSchema' },
  'settings-describe': { facing: 'model', note: 'settings-schema .describe — the schema is sent whole by /update-config and the validation error' },
  'local-jsx-system': { facing: 'ui', note: 'onDone(..., {display:"system"}) — transcript-only system entry' },
  'local-jsx-skip': { facing: 'ui', note: 'onDone(..., {display:"skip"}) — nothing is emitted' },
  'local-jsx-element': { facing: 'ui', note: 'returned from a local-jsx call() as the rendered element' },
  'jsx-children': { facing: 'ui', note: 'React/Ink children' },
  'jsx-prop': { facing: 'ui', note: 'prop of an intrinsic/unresolvable JSX element' },
  'jsx-render': { facing: 'ui', note: 'returned from a React component' },
  'tool-ui-method': { facing: 'ui', note: 'returned from a tool\'s userFacingName/render*/getActivityDescription' },
  // Process output is the terminal for the interactive CLI, but it is the
  // tool result when the model runs this code as a command through Bash
  // (the gh stand-in, `claude <subcommand>` helpers). The entry point decides.
  console: { facing: null, note: 'console.* — ui for the interactive CLI; model-facing when the model runs this entry point through Bash (check which command reaches it)' },
  stdio: { facing: null, note: 'process stdout/stderr — ui for the interactive CLI; model-facing when the model runs this entry point through Bash (the gh stand-in family)' },
  'cli-help': { facing: 'ui', note: 'commander option/description/help text' },
  throw: { facing: null, note: 'thrown outside a tool method: the catcher decides where the message goes (find the catch)' },
  compare: { facing: 'internal', note: 'compared/tested/used as a key, never emitted' },
  'debug-log': { facing: 'internal', note: 'debug/error logger' },
  analytics: { facing: 'internal', note: 'telemetry event payload' },
  'sdk-control-schema': { facing: 'internal', note: 'SDK control-protocol/message zod schema .describe' },
  'settings-describe-internal': { facing: 'internal', note: 'settings .describe starting with @internal (stripped before sending)' },
  'api-error-text': { facing: null, note: 'text of a synthetic assistant API-error message (isApiErrorMessage) — shown in the transcript; whether it is replayed to the model needs checking' },
  'tool-call-data': { facing: null, note: 'returned from a tool call(); reaches the model only if mapToolResultToToolResultBlockParam forwards this field' },
  'local-command-return': { facing: null, note: 'local command result that is not {type:"text"}' },
  'command-description': { facing: null, note: 'description of a slash command object' },
});

// ---------------------------------------------------------------------------
// Static tables.
const STRING_PASSTHROUGH = new Set([
  'trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight', 'replace', 'replaceAll',
  'padStart', 'padEnd', 'concat', 'toString', 'normalize', 'slice', 'substring',
  'substr', 'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase',
  'repeat', 'toLocaleString', 'valueOf', 'filter', 'reverse', 'sort', 'toSorted',
  'toReversed', 'flat', 'finally', 'catch', 'trimEnd', 'with',
]);
const POP_ELEMENT = new Set(['at', 'find', 'findLast', 'pop', 'shift']);
const COMPARE_METHODS = new Set([
  'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match',
  'matchAll', 'search', 'test', 'localeCompare', 'charAt', 'charCodeAt',
  'codePointAt', 'has', 'exec', 'some', 'every', 'findIndex', 'findLastIndex',
]);
const CALLBACK_METHODS = new Set(['map', 'flatMap', 'forEach', 'reduce', 'reduceRight', 'then', 'filter', 'find', 'some', 'every', 'sort', 'findIndex', 'findLast']);
// Callbacks whose return value becomes (part of) the call result.
const CALLBACK_RETURNS = Object.assign(Object.create(null), { map: '+[]', flatMap: '', then: '', reduce: '', reduceRight: '', replace: '', replaceAll: '', useMemo: '', useState: '', catch: '', finally: '' });
const HOF_PASSTHROUGH = new Set(['useCallback', 'memo', 'forwardRef', 'useEffectEvent']);
const HOF_DISCARD = new Set(['forEach', 'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'filter', 'some', 'every', 'find', 'findIndex', 'sort', 'addEventListener', 'on', 'once', 'subscribe']);
const CONTAINER_IN = new Set(['push', 'unshift', 'add', 'set', 'splice', 'fill']);
// Library calls that return their text argument restyled (chalk, ansi utils).
const TEXT_PASSTHROUGH_CALLS = new Set([
  'stripANSI', 'stripAnsi', 'sliceAnsi', 'wrapAnsi', 'truncate', 'red', 'green',
  'yellow', 'blue', 'cyan', 'magenta', 'white', 'gray', 'grey', 'black', 'bold',
  'dim', 'italic', 'underline', 'inverse', 'strikethrough', 'hex', 'rgb',
  'bgRed', 'bgGreen', 'bgYellow', 'bgBlue', 'redBright', 'greenBright',
  'yellowBright', 'blueBright', 'cyanBright', 'whiteBright', 'blackBright',
]);
const CLI_HELP = new Set([
  'option', 'requiredOption', 'addOption', 'argument', 'addArgument',
  'helpOption', 'addHelpText', 'usage', 'summary', 'showHelpAfterError',
  'addHelpCommand', 'helpCommand', 'version',
]);
const CLI_CHAIN = /\.(command|option|argument|name|alias|usage|helpOption|addHelpText|version|requiredOption|allowUnknownOption|enablePositionalOptions|passThroughOptions|action|hook|addCommand)\(/;
const ZOD_CHAIN = new Set([
  'optional', 'nullable', 'nullish', 'default', 'describe', 'catch', 'array',
  'or', 'and', 'refine', 'superRefine', 'transform', 'pipe', 'min', 'max',
  'int', 'positive', 'nonnegative', 'length', 'regex', 'url', 'email', 'uuid',
  'passthrough', 'strict', 'strip', 'extend', 'merge', 'partial', 'required',
  'pick', 'omit', 'brand', 'readonly', 'meta', 'check', 'nonempty', 'gte', 'lte',
  'gt', 'lt', 'finite', 'safe', 'trim', 'datetime', 'catchall', 'loose', 'prefault',
]);
const ERROR_CTORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'EvalError', 'URIError']);
const STRINGIFY_GLOBALS = new Set(['String', 'encodeURIComponent', 'encodeURI', 'escape', 'unescape', 'decodeURIComponent', 'decodeURI']);
const TOOL_MODEL_METHODS = Object.assign(Object.create(null), { prompt: 'tool-prompt', description: 'tool-prompt', mapToolResultToToolResultBlockParam: 'tool-result-mapper', validateInput: 'tool-validate', call: 'tool-call-data' });
const TOOL_UI_METHODS = new Set([
  'userFacingName', 'renderToolUseMessage', 'renderToolResultMessage',
  'renderToolUseRejectedMessage', 'renderToolUseErrorMessage',
  'renderToolUseProgressMessage', 'renderToolUseQueuedMessage',
  'getActivityDescription', 'getToolUseSummary', 'renderGroupedToolUse',
  'renderToolUseTag', 'userFacingNameBackgroundColor', 'extractSearchText',
]);
const DISTINCTIVE_METHODS = Object.assign(Object.create(null), {
  mapToolResultToToolResultBlockParam: 'tool-result-mapper',
  validateInput: 'tool-validate',
  getPromptForCommand: 'command-prompt',
  userFacingName: 'tool-ui-method',
  renderToolUseMessage: 'tool-ui-method',
  renderToolResultMessage: 'tool-ui-method',
  renderToolUseRejectedMessage: 'tool-ui-method',
  renderToolUseErrorMessage: 'tool-ui-method',
  renderToolUseProgressMessage: 'tool-ui-method',
  renderToolUseQueuedMessage: 'tool-ui-method',
  getActivityDescription: 'tool-ui-method',
  getToolUseSummary: 'tool-ui-method',
});
const LOGGER_NAMES = /^(logForDebugging|logError|logAntError|logMCPDebug|logMCPError|logEvent|logEventAsync|logForDiagnostics\w*|debugLog|logDebug|logWarn\w*|logInfo|trackEvent|logOTelEvent|logTelemetry\w*)$/;
const TOOL_SHAPE = keys => keys.includes('name') && (keys.includes('inputSchema') || keys.includes('inputJSONSchema')) && (keys.includes('call') || keys.includes('prompt'));
const COMMAND_TYPES = new Set(['local', 'local-jsx', 'prompt']);

const isFn = n => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
const propName = (p) => {
  if (!p || !p.key) return null;
  const k = p.key;
  if (!p.computed) {
    if (k.type === 'Identifier') return k.name;
    if (k.type === 'Literal') return String(k.value);
  } else if (k.type === 'Literal' && typeof k.value === 'string') return k.value;
  return null;
};
const memberName = (m) => {
  if (!m || m.type !== 'MemberExpression') return null;
  if (!m.computed && m.property.type === 'Identifier') return m.property.name;
  if (m.property.type === 'Literal' && (typeof m.property.value === 'string' || typeof m.property.value === 'number')) return String(m.property.value);
  return null;
};
const isIndex = k => /^\d+$/.test(k);
const literalValue = (n) => {
  if (!n) return undefined;
  if (n.type === 'Literal' && (typeof n.value === 'string' || typeof n.value === 'boolean' || typeof n.value === 'number')) return n.value;
  if (n.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis[0].value.cooked;
  if (n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return !n.argument.value;
  return undefined;
};
const unwrapAwait = n => (n && n.type === 'AwaitExpression' ? n.argument : n);

// ---------------------------------------------------------------------------
// One parsed + scoped module. Positions are absolute bundle offsets.
class ModuleInfo {
  constructor(seg, index) {
    this.seg = seg;
    this.index = index;
    this.base = seg.start;
    this.ast = acorn.parse(seg.source, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, allowHashBang: true, allowReturnOutsideFunction: true });
    this.scope = eslintScope.analyze(this.ast, { ecmaVersion: 2022, sourceType: 'module' });
    this.varOf = new Map(); // identifier node -> Variable
    this.varByKey = new Map(); // abs def start -> Variable
    for (const sc of this.scope.scopes) {
      for (const v of sc.variables) {
        if (!v.defs.length) continue;
        const key = this.base + v.defs[0].name.start;
        this.varByKey.set(key, v);
        for (const d of v.defs) this.varOf.set(d.name, v);
        for (const r of v.references) this.varOf.set(r.identifier, v);
      }
      for (const r of sc.references) if (r.resolved) this.varOf.set(r.identifier, r.resolved);
    }
    this.byStart = new Map(); // abs start -> [nodes]
    const walk = (node, parent) => {
      node.parent = parent;
      const abs = this.base + node.start;
      const list = this.byStart.get(abs);
      if (list) list.push(node); else this.byStart.set(abs, [node]);
      for (const key in node) {
        if (key === 'parent') continue;
        const c = node[key];
        if (!c || typeof c !== 'object') continue;
        if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') walk(x, node); }
        else if (typeof c.type === 'string' && key !== 'loc') walk(c, node);
      }
    };
    walk(this.ast, null);
  }
  abs(n) { return this.base + n.start; }
  // Calls can share a start (`f(a)(b)`), so a call is named by start+length.
  cid(n) { return `${this.base + n.start}+${n.end - n.start}`; }
  find(abs, pred) { return (this.byStart.get(abs) || []).find(pred) || null; }
  varKey(v) { return v && v.defs.length ? this.base + v.defs[0].name.start : null; }
  snippet(n, before = 60, after = 60) {
    const s = this.seg.source;
    return s.slice(Math.max(0, n.start - before), Math.min(s.length, n.end + after)).replace(/\s+/g, ' ');
  }
}

// ---------------------------------------------------------------------------
export class RouteProgram {
  constructor(code, opts = {}) {
    this.code = code;
    this.segments = splitModuleBundle(code) || [{ name: '<bundle>', start: 0, source: code }];
    this.segStarts = this.segments.map(s => s.start);
    this.modIndex = new Map(this.segments.map((s, i) => [s.name, i]));
    this.lru = new Map();
    this.lruBytes = 0;
    this.lruMaxBytes = opts.lruMaxBytes || 16e6;
    this.memo = new Map(); // node key -> outcomes
    this.shapes = new Map(); // abs object start -> shape
    this.fnInfo = new Map(); // abs fn start -> {jsx, zod, names, kind}
    this.bindFn = new Map(); // binding key -> resolved fn start | null | {dyn}
    this.settingsIndex = opts.settingsIndex || new Map();
    this.callersMemo = new Map();
    this.argFnsMemo = new Map();
    this.classMemo = new Map();
    this.ondoneSites = null;
    this.scanned = false;
    this.stats = { parsed: 0 };
  }

  // ----- module access ------------------------------------------------------
  segIndexAt(abs) {
    let lo = 0, hi = this.segStarts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segStarts[mid] <= abs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  module(i) {
    // A summary loaded without its bundle answers from the memo only.
    if (!this.segments) return { failed: 'offline: the bundle is not loaded' };
    let m = this.lru.get(i);
    if (m) { this.lru.delete(i); this.lru.set(i, m); return m; }
    try { m = new ModuleInfo(this.segments[i], i); } catch (e) { m = { failed: e.message }; }
    this.stats.parsed++;
    this.lru.set(i, m);
    this.lruBytes += this.segments[i].source.length;
    // Budget by source size: the 4.5 MB main chunk alone outweighs hundreds
    // of small modules, and it is touched by most traces.
    while (this.lru.size > 1 && this.lruBytes > this.lruMaxBytes) {
      const k = this.lru.keys().next().value;
      this.lru.delete(k);
      this.lruBytes -= this.segments[k].source.length;
    }
    return m;
  }
  moduleAt(abs) { return this.module(this.segIndexAt(abs)); }

  // ----- whole-bundle scan: imports, exports, commands, zod modules ---------
  scan() {
    if (this.scanned) return;
    this.exportsOf = new Map(); // module -> Map(name -> {bind}|{from:[m,n]})
    this.starExports = new Map(); // module -> [src]
    this.importers = new Map(); // `${m}|${name}` -> [local binding key]
    this.importSpec = new Map(); // local binding key -> [src, name] | [src, '*']
    this.dynImported = new Set();
    this.commandModules = new Map(); // module -> {type, name}
    this.inlineCommandFns = new Map(); // fn start -> {type, name, key}
    this.zodModules = new Set();
    this.names = new Map(); // binding key -> Set(public names)
    this.dynSites = new Map(); // module -> [abs of import() expressions that are not command loaders]
    const typeByName = new Map();
    const registry = [];
    const loaderSites = new Set();
    const dynSites = [];
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      let ast;
      try { ast = acorn.parse(seg.source, { ecmaVersion: 'latest', sourceType: 'module', ranges: true, allowHashBang: true, allowReturnOutsideFunction: true }); }
      catch { continue; }
      if (/\bZodError\b|"ZodObject"|_zod\b/.test(seg.source)) this.zodModules.add(seg.name);
      const top = new Map();
      const exp = new Map();
      for (const st of ast.body) {
        if (st.type === 'ImportDeclaration') {
          const src = st.source.value;
          for (const sp of st.specifiers) {
            const key = seg.start + sp.local.start;
            const name = sp.type === 'ImportSpecifier' ? (sp.imported.name ?? sp.imported.value) : sp.type === 'ImportDefaultSpecifier' ? 'default' : '*';
            this.importSpec.set(key, [src, name]);
            if (name !== '*') {
              const k = `${src}|${name}`;
              (this.importers.get(k) || this.importers.set(k, []).get(k)).push(key);
            }
            top.set(sp.local.name, key);
          }
        } else if (st.type === 'VariableDeclaration') {
          for (const d of st.declarations) for (const id of patternIds(d.id)) top.set(id.name, seg.start + id.start);
        } else if (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') {
          if (st.id) top.set(st.id.name, seg.start + st.id.start);
        } else if (st.type === 'ExportNamedDeclaration') {
          if (st.declaration) {
            const d = st.declaration;
            const ids = d.type === 'VariableDeclaration' ? d.declarations.flatMap(x => patternIds(x.id)) : d.id ? [d.id] : [];
            for (const id of ids) { top.set(id.name, seg.start + id.start); exp.set(id.name, { local: id.name }); }
          }
          for (const sp of st.specifiers || []) {
            const ename = sp.exported.name ?? sp.exported.value;
            const lname = sp.local.name ?? sp.local.value;
            if (st.source) exp.set(ename, { from: [st.source.value, lname] });
            else exp.set(ename, { local: lname });
          }
        } else if (st.type === 'ExportAllDeclaration') {
          if (st.exported) exp.set(st.exported.name, { from: [st.source.value, '*'] });
          else (this.starExports.get(seg.name) || this.starExports.set(seg.name, []).get(seg.name)).push(st.source.value);
        } else if (st.type === 'ExportDefaultDeclaration') {
          const d = st.declaration;
          if (d.id) { top.set(d.id.name, seg.start + d.id.start); exp.set('default', { local: d.id.name }); }
          else exp.set('default', { expr: seg.start + d.start });
        }
      }
      const table = new Map();
      for (const [ename, e] of exp) {
        if (e.local) {
          const key = top.get(e.local);
          if (key != null) {
            table.set(ename, { bind: key });
            if (ename !== e.local && ename.length >= 4 && ename !== 'default') {
              (this.names.get(key) || this.names.set(key, new Set()).get(key)).add(ename);
            }
          }
        } else table.set(ename, e);
      }
      this.exportsOf.set(seg.name, table);
      // Command registrations and dynamic imports.
      walkPlain(ast, (n) => {
        if (n.type === 'ImportExpression' && n.source.type === 'Literal') {
          this.dynImported.add(n.source.value);
          dynSites.push([n.source.value, seg.start + n.start, n]);
        }
        if (n.type !== 'ObjectExpression') return;
        // A name -> loader registry: {help:()=>import("M"), ...}.
        let loaders = 0;
        for (const p of n.properties) {
          if (p.type === 'Property' && isFn(p.value) && !p.value.params.length && p.value.body.type === 'ImportExpression' && p.value.body.source.type === 'Literal') loaders++;
        }
        if (loaders >= 3) {
          for (const p of n.properties) {
            const k = propName(p);
            if (k && p.type === 'Property' && isFn(p.value) && p.value.body.type === 'ImportExpression' && p.value.body.source.type === 'Literal') {
              registry.push([k, p.value.body.source.value]);
              loaderSites.add(seg.start + p.value.body.start);
            }
          }
        }
        let type = null, name = null, load = null, call = null, getPrompt = null;
        for (const p of n.properties) {
          if (p.type !== 'Property') continue;
          const k = propName(p);
          if (k === 'type') type = literalValue(p.value);
          else if (k === 'name') name = literalValue(p.value);
          else if (k === 'load') load = p.value;
          else if (k === 'call') call = p.value;
          else if (k === 'getPromptForCommand') getPrompt = p.value;
        }
        if (!COMMAND_TYPES.has(type) || typeof name !== 'string') return;
        (typeByName.get(name) || typeByName.set(name, new Set()).get(name)).add(type);
        if (load && isFn(load)) {
          let body = load.body;
          if (body.type === 'BlockStatement') {
            const r = body.body.find(s => s.type === 'ReturnStatement');
            body = r && r.argument;
          }
          body = unwrapAwait(body);
          if (body && body.type === 'ImportExpression' && body.source.type === 'Literal') {
            this.commandModules.set(body.source.value, { type, name });
            loaderSites.add(seg.start + body.start);
          }
        }
        if (call && isFn(call)) this.inlineCommandFns.set(seg.start + call.start, { type, name, key: 'call' });
        if (getPrompt && isFn(getPrompt)) this.inlineCommandFns.set(seg.start + getPrompt.start, { type, name, key: 'getPromptForCommand' });
      });
    }
    // Commands whose object carries no `load` are wired through a name ->
    // loader registry; the command's type comes from its object by name. A
    // name registered as both local and local-jsx keeps both (each module is
    // then checked against both shapes).
    for (const [name, mod] of registry) {
      const types = typeByName.get(name);
      if (!types || this.commandModules.has(mod)) continue;
      const type = types.has('local-jsx') ? 'local-jsx' : types.has('local') ? 'local' : [...types][0];
      this.commandModules.set(mod, { type, name, ...(types.size > 1 ? { ambiguous: [...types] } : {}) });
    }
    for (const [mod, abs, node] of dynSites) {
      if (loaderSites.has(abs)) continue;
      (this.dynSites.get(mod) || this.dynSites.set(mod, []).get(mod)).push(abs);
      void node;
    }
    // Names travel through re-exports: `export{t as logForDebugging}` of an
    // imported `t` names the binding in the module that defines it.
    for (const [key, set] of [...this.names]) {
      const target = this.resolveImportAlias(key);
      if (target != null && target !== key) {
        const s = this.names.get(target) || this.names.set(target, new Set()).get(target);
        for (const n of set) s.add(n);
      }
    }
    this.scanned = true;
  }

  // Follow an import binding to the binding it names in its source module.
  resolveImportAlias(key, depth = 0) {
    const spec = this.importSpec && this.importSpec.get(key);
    if (!spec || depth > 12) return key;
    const [src, name] = spec;
    if (name === '*') return key;
    const target = this.resolveExport(src, name, depth + 1);
    return target == null ? key : target;
  }
  resolveExport(mod, name, depth = 0) {
    if (depth > 12) return null;
    const t = this.exportsOf.get(mod);
    if (!t) return null;
    const e = t.get(name);
    if (e) {
      if (e.bind != null) return this.resolveImportAlias(e.bind, depth + 1);
      if (e.from) return e.from[1] === '*' ? null : this.resolveExport(e.from[0], e.from[1], depth + 1);
      return null;
    }
    for (const src of this.starExports.get(mod) || []) {
      const r = this.resolveExport(src, name, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  publicNames(bindKey) {
    const k = this.resolveImportAlias(bindKey);
    return this.names.get(k) || this.names.get(bindKey) || null;
  }

  // ----- function resolution ------------------------------------------------
  // binding key -> {fn: abs start} | {param: true} | null. Only a binding that
  // provably holds one function resolves; anything reassigned is dynamic.
  resolveFn(bindKey) {
    if (this.bindFn.has(bindKey)) return this.bindFn.get(bindKey);
    this.bindFn.set(bindKey, null);
    const res = this._resolveFn(bindKey);
    this.bindFn.set(bindKey, res);
    return res;
  }
  _resolveFn(bindKey0) {
    this.scan();
    const bindKey = this.resolveImportAlias(bindKey0);
    if (this.importSpec.has(bindKey)) return null; // unresolved import
    const m = this.moduleAt(bindKey);
    if (m.failed) return null;
    const v = m.varByKey.get(bindKey);
    if (!v) return null;
    const d = v.defs[0];
    if (d.type === 'FunctionName') return { fn: m.abs(d.node), bind: bindKey };
    if (d.type === 'Variable') {
      const writes = v.references.filter(r => r.isWrite());
      // `[state, setState] = useState(x)`: calling the setter stores into state.
      if (d.node.init && d.node.id.type === 'ArrayPattern' && d.node.id.elements[1] === d.name && d.node.init.type === 'CallExpression' && d.node.init.callee.type === 'Identifier') {
        const hv = m.varOf.get(d.node.init.callee);
        const hr = hv ? this.resolveFn(m.varKey(hv)) : null;
        const hook = hr && hr.fn != null ? this.fnFlags(hr.fn).hook : null;
        const st0 = d.node.id.elements[0];
        if ((hook === 'useState' || hook === 'useReducer') && st0 && st0.type === 'Identifier' && m.varOf.get(st0)) {
          return { setter: m.varKey(m.varOf.get(st0)), bind: bindKey };
        }
      }
      if (writes.length === 1 && d.node.init && writes[0].writeExpr === d.node.init) {
        const init = d.node.init;
        // `X = useCallback(fn, deps)`
        if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.arguments.length >= 1 && isFn(init.arguments[0])) {
          const hv = m.varOf.get(init.callee);
          const hr = hv ? this.resolveFn(m.varKey(hv)) : null;
          if (hr && hr.fn != null && this.fnFlags(hr.fn).hook === 'useCallback') return { fn: m.abs(init.arguments[0]), bind: bindKey, wrapped: true };
        }
        if (isFn(init)) return { fn: m.abs(init), bind: bindKey };
        // `let {call:X} = await import("M")`
        const imp = unwrapAwait(init);
        if (imp && imp.type === 'ImportExpression' && imp.source.type === 'Literal' && d.node.id.type === 'ObjectPattern') {
          const k = destructuredKey(d.node.id, d.name);
          if (k) {
            const t = this.resolveExport(imp.source.value, k);
            return t == null ? null : this.resolveFn(t);
          }
        }
        // `var X = Y` alias of another function binding
        if (init.type === 'Identifier') {
          const iv = m.varOf.get(init);
          if (iv && iv !== v) return this.resolveFn(m.varKey(iv));
        }
        if (init.type === 'ClassExpression') return this.classTarget(m, init);
        // `X = c ? f : g`: either function may be the callee.
        if (init.type === 'ConditionalExpression' || init.type === 'LogicalExpression') {
          const arms = init.type === 'ConditionalExpression' ? [init.consequent, init.alternate] : [init.left, init.right];
          const fns = [];
          for (const a of arms) {
            if (isFn(a)) fns.push(m.abs(a));
            else if (a.type === 'Identifier' && m.varOf.get(a)) {
              const r = this.resolveFn(m.varKey(m.varOf.get(a)));
              if (r && r.fn != null && !r.param) fns.push(r.fn);
            }
          }
          if (fns.length) return { fns, bind: bindKey };
        }
        // `X = memoize(() => ...)`, `X = once(fn)`: a wrapper around exactly
        // one function forwards its call to that function.
        if (init.type === 'CallExpression' && init.arguments.length === 1) {
          const a = init.arguments[0];
          if (isFn(a)) return { fn: m.abs(a), bind: bindKey, wrapped: true };
          if (a.type === 'Identifier' && m.varOf.get(a)) {
            const r = this.resolveFn(m.varKey(m.varOf.get(a)));
            if (r && r.fn != null && !r.param) return { ...r, wrapped: true };
          }
        }
      }
      return null;
    }
    if (d.type === 'Parameter') {
      // `import("M").then(({k:X}) => X(...))`
      const fnNode = d.node;
      const call = fnNode.parent;
      if (call && call.type === 'CallExpression' && call.arguments[0] === fnNode && memberName(call.callee) === 'then') {
        const obj = unwrapAwait(call.callee.object);
        if (obj.type === 'ImportExpression' && obj.source.type === 'Literal' && fnNode.params[0] && fnNode.params[0].type === 'ObjectPattern') {
          const k = destructuredKey(fnNode.params[0], d.name);
          if (k) {
            const t = this.resolveExport(obj.source.value, k);
            return t == null ? null : this.resolveFn(t);
          }
        }
      }
      const j = fnNode.params.indexOf(d.name);
      // `new Promise((resolve, reject) => …)`: resolve(x) settles the
      // promise with x; reject(e) raises e where the promise is awaited.
      const np = fnNode.parent;
      if (j >= 0 && j <= 1 && np && np.type === 'NewExpression' && np.arguments[0] === fnNode && np.callee.type === 'Identifier' && np.callee.name === 'Promise' && !m.varOf.get(np.callee)) {
        return { promise: m.cid(np), reject: j === 1 };
      }
      if (j >= 0) return { param: true, fn: m.abs(fnNode), index: j };
      for (let pj = 0; pj < fnNode.params.length; pj++) {
        const pp = fnNode.params[pj];
        if (pp.type === 'ObjectPattern') {
          const k = destructuredKey(pp, d.name);
          if (k) return { param: true, fn: m.abs(fnNode), index: pj, key: k };
        }
      }
      return { param: true };
    }
    if (d.type === 'ClassName') return this.classTarget(m, d.node);
    return null;
  }

  // `new X(msg)`: an Error subclass carries msg as .message; any other class
  // hands its arguments to its constructor.
  classTarget(m, cls, depth = 0) {
    if (!cls || depth > 8) return null;
    const sup = cls.superClass;
    const ctor = cls.body.body.find(x => x.type === 'MethodDefinition' && x.kind === 'constructor');
    let errorClass = false;
    if (sup && sup.type === 'Identifier') {
      if (!m.varOf.get(sup) && ERROR_CTORS.has(sup.name)) errorClass = true;
      const sv = m.varOf.get(sup);
      if (sv) {
        const r = this.resolveFn(m.varKey(sv));
        if (r && r.errorClass) errorClass = true;
      }
    }
    // An Error subclass without its own constructor forwards argument 0 to
    // Error as the message; with one, the constructor decides (super(msg)
    // is followed through the errorClass flag on the class).
    if (errorClass) return ctor ? { errorClass: true, fn: m.abs(ctor.value), ctor: true } : { errorClass: true };
    if (ctor) return { fn: m.abs(ctor.value), ctor: true };
    return sup ? { inherited: true } : { noCtor: true };
  }

  // The function(s) passed as argument j (or its property `key`) at call cs.
  argFnsAt(cs, j, key) {
    const mk = `${cs}|${j}|${key ?? ''}`;
    if (this.argFnsMemo.has(mk)) return this.argFnsMemo.get(mk);
    const r = this._argFnsAt(cs, j, key);
    if (!this.offline) this.argFnsMemo.set(mk, r);
    return r;
  }
  _argFnsAt(cs, j, key) {
    const abs = Number(String(cs).split('+')[0]);
    const len = Number(String(cs).split('+')[1]);
    const m = this.moduleAt(abs);
    if (m.failed) return null;
    const call = m.find(abs, x => (x.type === 'CallExpression' || x.type === 'NewExpression') && (!len || x.end - x.start === len));
    if (!call) return null;
    let arg = call.arguments[j];
    if (!arg) return [];
    if (key != null) {
      if (arg.type !== 'ObjectExpression') return null;
      const p = arg.properties.find(x => x.type === 'Property' && propName(x) === key);
      if (!p) return [];
      arg = p.value;
    }
    if (isFn(arg)) return [m.abs(arg)];
    if (arg.type === 'Identifier') {
      const v = m.varOf.get(arg);
      if (!v) return null;
      const r = this.resolveFn(m.varKey(v));
      if (r && r.fn != null && !r.param) return [r.fn];
      if (r && r.fns) return r.fns;
      return null;
    }
    return null;
  }

  whyNotFn(bindKey0) {
    if (this.offline) return 'not in the cached summary';
    const bindKey = this.resolveImportAlias(bindKey0);
    const spec = this.importSpec.get(bindKey);
    if (spec) return `import ${spec[1]} from ${spec[0].split('/').pop()} not resolved`;
    const m = this.moduleAt(bindKey);
    const v = m.failed ? null : m.varByKey.get(bindKey);
    if (!v) return 'no binding';
    const d = v.defs[0];
    const writes = v.references.filter(r => r.isWrite()).length;
    const init = d.node && d.node.init ? d.node.init.type : 'none';
    return `${d.type}${d.type === 'Variable' ? ` init ${init}, ${writes} write(s)` : ''}`;
  }

  fnFlags(fnAbs) {
    if (this.fnInfo.has(fnAbs)) return this.fnInfo.get(fnAbs);
    const m = this.moduleAt(fnAbs);
    const info = { jsx: false, zod: false };
    if (!m.failed) {
      const fn = m.find(fnAbs, isFn);
      if (fn) {
        info.zod = this.zodModules.has(m.seg.name);
        // A JSX factory returns {$$typeof, type, props}.
        walkPlain(fn.body, (n) => {
          if (n.type === 'ObjectExpression') {
            const ks = n.properties.map(propName);
            if (ks.includes('$$typeof') && ks.includes('props')) info.jsx = true;
          }
        }, isFn);
        info.async = !!fn.async;
        info.rest = fn.params.findIndex(x => x.type === 'RestElement');
        // React re-exports each hook as `function(e){return X.H.useY(e)}`.
        const body = fn.body;
        const ret = body.type === 'BlockStatement' && body.body.length === 1 && body.body[0].type === 'ReturnStatement' ? body.body[0].argument : body.type !== 'BlockStatement' ? body : null;
        if (ret && ret.type === 'CallExpression' && ret.callee.type === 'MemberExpression') {
          const hn = memberName(ret.callee);
          if (hn && /^use[A-Z]?\w*$/.test(hn) && ret.callee.object.type === 'MemberExpression' && memberName(ret.callee.object) === 'H') info.hook = hn;
        }
      }
    }
    this.fnInfo.set(fnAbs, info);
    return info;
  }

  // ----- outcome computation (module-local) ---------------------------------
  outcomes(key) {
    let o = this.memo.get(key);
    if (o) return o;
    try { o = this._outcomes(key); } catch (e) { o = [{ u: `analysis error: ${e.message}` }]; }
    this.memo.set(key, o);
    return o;
  }
  _outcomes(key) {
    this.scan();
    const kind = key[0];
    const abs = Number(key.slice(1).split(/[.+]/)[0]);
    const m = this.moduleAt(abs);
    if (m.failed) return [{ u: `module unparseable: ${m.failed}` }];
    if (kind === 'L') {
      const n = m.find(abs, x => x.type === 'Literal' || x.type === 'TemplateLiteral');
      if (!n) return [{ u: 'no literal at offset' }];
      return this.flowUp(m, n, []);
    }
    if (kind === 'T') {
      // An exception escaping the call at this site.
      const len = Number(key.split('+')[1]);
      const n = m.find(abs, x => (x.type === 'CallExpression' || x.type === 'NewExpression') && (!len || x.end - x.start === len));
      if (!n) return [{ u: 'no call at offset' }];
      // `f().catch(cb)` / `f().then(ok, cb)`
      const par = n.parent && n.parent.type === 'AwaitExpression' ? n.parent : n;
      const mem = par.parent;
      if (mem && mem.type === 'MemberExpression' && mem.object === par && mem.parent && mem.parent.type === 'CallExpression' && mem.parent.callee === mem) {
        const mn = memberName(mem);
        const cb = mn === 'catch' ? mem.parent.arguments[0] : mn === 'then' ? mem.parent.arguments[1] : null;
        if (cb && isFn(cb)) return [{ t: `P${m.abs(cb)}.0` }];
      }
      return this.exceptionFrom(m, n, []);
    }
    if (kind === 'N') {
      const n = m.find(abs, x => x.type === 'ImportExpression');
      if (!n) return [{ u: 'no import() at offset' }];
      return this.flowUp(m, n, []);
    }
    if (kind === 'C') {
      const len = Number(key.split('+')[1]);
      const n = m.find(abs, x => (x.type === 'CallExpression' || x.type === 'NewExpression') && (!len || x.end - x.start === len));
      if (!n) return [{ u: 'no call at offset' }];
      return this.flowUp(m, n, []);
    }
    if (kind === 'B') {
      const v = m.varByKey.get(abs);
      if (!v) return [{ u: 'no binding at offset' }];
      const out = [];
      for (const r of v.references) {
        if (!r.isRead()) continue;
        const outs = this.flowUp(m, r.identifier, []);
        const g = this.instanceofGuards(m, r.identifier, v);
        if (g.length) for (const o of outs) o.g = g;
        out.push(...outs);
      }
      const spec = this.importSpec.get(abs);
      if (spec && spec[1] === '*') out.push({ u: 'namespace import' });
      return out;
    }
    if (kind === 'P') {
      const i = Number(key.split('.')[1]);
      const fn = m.find(abs, isFn);
      if (!fn) return [{ u: 'no function at offset' }];
      const restIdx = fn.params.findIndex(p => p.type === 'RestElement');
      if (restIdx >= 0 && i >= restIdx) return this.patternOutcomes(m, fn.params[restIdx].argument, ['+[]']);
      const p = fn.params[i];
      if (!p) return [{ d: 'argument not bound to a parameter' }];
      return this.patternOutcomes(m, p, []);
    }
    if (kind === 'V') {
      const fn = m.find(abs, isFn);
      if (!fn) return [{ u: 'no function at offset' }];
      if (fn.type === 'FunctionDeclaration' && fn.id) {
        const v = m.varOf.get(fn.id);
        return v ? [{ t: 'B' + m.varKey(v) }] : [];
      }
      const p = fn.parent;
      if (p && p.type === 'VariableDeclarator' && p.init === fn && p.id.type === 'Identifier') {
        const v = m.varOf.get(p.id);
        return v ? [{ t: 'B' + m.varKey(v) }] : [];
      }
      return this.flowUp(m, fn, []);
    }
    return [{ u: `unknown node key ${key}` }];
  }

  patternOutcomes(m, pat, ops) {
    if (!pat) return [];
    switch (pat.type) {
      case 'Identifier': {
        const v = m.varOf.get(pat);
        return v ? [{ o: ops, t: 'B' + m.varKey(v) }] : [{ o: ops, u: 'unbound identifier' }];
      }
      case 'ObjectPattern': {
        const out = [];
        for (const p of pat.properties) {
          if (p.type === 'RestElement') out.push(...this.patternOutcomes(m, p.argument, ops));
          else {
            const k = propName(p);
            out.push(...this.patternOutcomes(m, p.value, [...ops, k == null ? '-*' : '-' + k]));
          }
        }
        return out;
      }
      case 'ArrayPattern': {
        const out = [];
        for (const el of pat.elements) {
          if (!el) continue;
          if (el.type === 'RestElement') out.push(...this.patternOutcomes(m, el.argument, ops));
          else out.push(...this.patternOutcomes(m, el, [...ops, '-[]']));
        }
        return out;
      }
      case 'AssignmentPattern':
        return this.patternOutcomes(m, pat.left, ops);
      case 'MemberExpression': {
        const k = memberName(pat);
        const obj = pat.object;
        if (obj.type === 'Identifier') {
          const v = m.varOf.get(obj);
          if (v) return [{ o: [...ops, '+' + (k ?? '*')], t: 'B' + m.varKey(v) }];
        }
        return [{ o: ops, u: 'stored into a property of a non-local object', at: m.abs(pat) }];
      }
      default:
        return [{ o: ops, u: `pattern ${pat.type}` }];
    }
  }

  base0(m) { return m.base; }

  shapeOf(m, obj) {
    const abs = m.abs(obj);
    if (this.shapes.has(abs)) return abs;
    const keys = [];
    const v = {};
    let zc = 0;
    let fns = null;
    for (const p of obj.properties) {
      if (p.type !== 'Property') { keys.push('...'); continue; }
      const k = propName(p);
      if (k == null) continue;
      if (keys.length < 40) keys.push(k);
      if (isFn(p.value) && (k === 'mapToolResultToToolResultBlockParam' || k === 'call' || k === 'create')) {
        (fns || (fns = {}))[k] = this.base0(m) + p.value.start;
      }
      const lv = literalValue(p.value);
      if (lv !== undefined && (typeof lv !== 'string' || lv.length <= 40)) v[k] = lv;
      if ((k === 'subtype' || k === 'type') && p.value.type === 'CallExpression' && p.value.arguments[0] && p.value.arguments[0].type === 'Literal') zc++;
    }
    const shape = { k: keys, v };
    if (zc) shape.z = zc;
    if (fns) shape.f = fns;
    // A throw/validate inside a tool needs the object-level tool shape.
    if (TOOL_SHAPE(keys)) shape.tool = 1;
    this.shapes.set(abs, shape);
    return abs;
  }

  // `if (x instanceof K) …x…`: a read of x that only happens when x is a K.
  // Returns the guard class binding keys ('Error' for the global).
  instanceofGuards(m, id, v) {
    const g = [];
    const isGuard = t => t && t.type === 'BinaryExpression' && t.operator === 'instanceof' && t.left.type === 'Identifier' && m.varOf.get(t.left) === v;
    const keyOf = t => {
      if (t.right.type !== 'Identifier') return '?';
      const rv = m.varOf.get(t.right);
      return rv ? String(this.resolveImportAlias(m.varKey(rv))) : t.right.name;
    };
    for (let n = id; n && n.parent && !isFn(n); n = n.parent) {
      const p = n.parent;
      if (p.type === 'IfStatement' && p.consequent === n && isGuard(p.test)) g.push(keyOf(p.test));
      else if (p.type === 'ConditionalExpression' && p.consequent === n && isGuard(p.test)) g.push(keyOf(p.test));
      else if (p.type === 'LogicalExpression' && p.operator === '&&' && p.right === n && isGuard(p.left)) g.push(keyOf(p.left));
    }
    return g;
  }

  // Is class binding `cls` (or 'Error') an instance of guard class `g`?
  // null when it cannot be decided.
  classIsA(cls, g, depth = 0) {
    const mk = `${cls}|${g}`;
    if (this.classMemo.has(mk)) return this.classMemo.get(mk);
    const r = this._classIsA(cls, g, depth);
    if (!this.offline) this.classMemo.set(mk, r);
    return r;
  }
  _classIsA(cls, g, depth = 0) {
    if (g === '?' || cls == null) return null;
    if (String(cls) === String(g)) return true;
    if (g === 'Error') return true; // every tracked thrown class derives from Error
    if (cls === 'Error' || depth > 10) return false;
    const key = Number(cls);
    const m = this.moduleAt(key);
    const v = m.failed ? null : m.varByKey.get(key);
    const d = v && v.defs[0];
    const node = d && (d.type === 'ClassName' ? d.node : d.node && d.node.init && d.node.init.type === 'ClassExpression' ? d.node.init : null);
    if (!node) return null;
    const sup = node.superClass;
    if (!sup) return false;
    if (sup.type !== 'Identifier') return null;
    const sv = m.varOf.get(sup);
    if (!sv) return ERROR_CTORS.has(sup.name) ? this.classIsA('Error', g, depth + 1) : null;
    return this.classIsA(String(this.resolveImportAlias(m.varKey(sv))), g, depth + 1);
  }

  // Where an exception raised at `node` goes: the innermost enclosing
  // try/catch of the same function binds it; otherwise it leaves the function
  // and surfaces at each call site (resolved by the interpreter).
  exceptionFrom(m, node, ops) {
    for (let n = node; n && n.parent; n = n.parent) {
      const p = n.parent;
      if (isFn(p)) return [{ o: ops, thr: m.abs(p) }];
      if (p.type === 'TryStatement' && p.block === n && p.handler) {
        if (!p.handler.param) return [{ o: ops, s: 'compare', at: m.abs(p.handler) }];
        return this.patternOutcomes(m, p.handler.param, ops);
      }
    }
    return [{ o: ops, s: 'throw', at: m.abs(node) }];
  }

  // Enclosing method of a tool-shaped object literal, if any.
  enclosingToolMethod(m, node) {
    for (let n = node; n; n = n.parent) {
      if (isFn(n) && n.parent && n.parent.type === 'Property' && n.parent.value === n) {
        const obj = n.parent.parent;
        const k = propName(n.parent);
        if (obj && obj.type === 'ObjectExpression' && (k === 'call' || k === 'validateInput' || k === 'checkPermissions')) {
          const keys = obj.properties.map(propName);
          if (TOOL_SHAPE(keys)) return k;
        }
      }
    }
    return null;
  }

  // Walk one value occurrence up its module-local AST until it leaves: a
  // sink, a hand-off, or an explicit unresolved.
  flowUp(m, start, ops0) {
    const out = [];
    let node = start;
    let ops = ops0.slice();
    const at = n => m.abs(n);
    for (let guard = 0; guard < 400; guard++) {
      const p = node.parent;
      if (!p) { out.push({ o: ops, d: 'program' }); return out; }
      switch (p.type) {
        case 'TemplateLiteral':
          ops.push('S'); node = p; continue;
        case 'TaggedTemplateExpression': {
          if (p.quasi === node) {
            const tag = p.tag;
            if (tag.type === 'MemberExpression' && memberName(tag) === 'raw') { node = p; continue; }
            out.push({ o: ops, u: 'tagged template', at: at(p) });
            return out;
          }
          out.push({ o: ops, d: 'tag' });
          return out;
        }
        case 'BinaryExpression':
          if (p.operator === '+') { ops.push('S'); node = p; continue; }
          out.push({ o: ops, s: 'compare', at: at(p) });
          return out;
        case 'LogicalExpression':
          node = p; continue;
        case 'ConditionalExpression':
          if (p.test === node) { out.push({ o: ops, s: 'compare', at: at(p) }); return out; }
          node = p; continue;
        case 'SequenceExpression':
          if (p.expressions[p.expressions.length - 1] === node) { node = p; continue; }
          out.push({ o: ops, d: 'discarded' });
          return out;
        case 'AwaitExpression':
        case 'ChainExpression':
        case 'ParenthesizedExpression':
          node = p; continue;
        case 'UnaryExpression':
        case 'UpdateExpression':
          out.push({ o: ops, s: 'compare', at: at(p) });
          return out;
        case 'SpreadElement':
          node = p.parent ? p : p;
          if (p.parent && p.parent.type === 'ArrayExpression') { node = p.parent; continue; }
          if (p.parent && p.parent.type === 'ObjectExpression') { node = p.parent; continue; }
          if (p.parent && (p.parent.type === 'CallExpression' || p.parent.type === 'NewExpression') && p.parent.callee !== p) {
            const ai = p.parent.arguments.indexOf(p);
            return out.concat(this.argOutcome(m, p.parent, ai, [...ops, '-[]'], true));
          }
          out.push({ o: ops, u: 'spread', at: at(p) });
          return out;
        case 'ArrayExpression':
          ops.push('+[]'); node = p; continue;
        case 'Property': {
          if (p.value !== node) { out.push({ o: ops, s: 'compare', at: at(p) }); return out; }
          const obj = p.parent;
          if (obj.type === 'ObjectPattern') { out.push({ o: ops, u: 'pattern default', at: at(p) }); return out; }
          const k = propName(p);
          const sh = this.shapeOf(m, obj);
          const isMethod = p.kind === 'get' || p.kind === 'set' || p.method;
          ops.push(`+${k == null ? '*' : k}@${sh}${isMethod ? '@m' : ''}`);
          node = obj;
          continue;
        }
        case 'MemberExpression': {
          if (p.object !== node) { out.push({ o: ops, s: 'compare', at: at(p) }); return out; }
          const name = memberName(p);
          const gp = p.parent;
          if (gp && (gp.type === 'CallExpression' || gp.type === 'NewExpression') && gp.callee === p) {
            return out.concat(this.methodOnValue(m, gp, name, ops));
          }
          if (gp && gp.type === 'ChainExpression' && gp.parent && gp.parent.type === 'CallExpression' && gp.parent.callee === gp) {
            return out.concat(this.methodOnValue(m, gp.parent, name, ops));
          }
          if (gp && gp.type === 'AssignmentExpression' && gp.left === p) { out.push({ o: ops, d: 'written-over' }); return out; }
          if (name === 'length') { out.push({ o: ops, s: 'compare', at: at(p) }); return out; }
          ops.push(name == null ? '-*' : '-' + name);
          node = p;
          continue;
        }
        case 'CallExpression':
        case 'NewExpression': {
          if (p.callee === node) { out.push({ o: ops, called: m.cid(p) }); return out; }
          const i = p.arguments.indexOf(node);
          return out.concat(this.argOutcome(m, p, i, ops));
        }
        case 'ReturnStatement': {
          const fn = enclosingFn(p);
          if (!fn) { out.push({ o: ops, d: 'module return' }); return out; }
          out.push({ o: ops, t: 'R' + at(fn) });
          return out;
        }
        case 'ArrowFunctionExpression':
          if (p.body === node) { out.push({ o: ops, t: 'R' + at(p) }); return out; }
          out.push({ o: ops, u: 'default parameter value', at: at(p) });
          return out;
        case 'VariableDeclarator':
          if (p.init === node) return out.concat(this.patternOutcomes(m, p.id, ops));
          out.push({ o: ops, d: 'declarator id' });
          return out;
        case 'AssignmentExpression': {
          if (p.right !== node) { out.push({ o: ops, d: 'assignment target' }); return out; }
          const ops2 = p.operator === '=' ? ops : [...ops, 'S'];
          out.push(...this.patternOutcomes(m, p.left, ops2));
          if (p.parent && p.parent.type !== 'ExpressionStatement' && p.parent.type !== 'SequenceExpression') { node = p; ops = ops2; continue; }
          return out;
        }
        case 'AssignmentPattern':
          if (p.right === node) return out.concat(this.patternOutcomes(m, p.left, ops));
          out.push({ o: ops, d: 'pattern' });
          return out;
        case 'ForOfStatement':
          if (p.right === node) {
            const left = p.left.type === 'VariableDeclaration' ? p.left.declarations[0].id : p.left;
            return out.concat(this.patternOutcomes(m, left, [...ops, '-[]']));
          }
          out.push({ o: ops, d: 'loop' });
          return out;
        case 'ForInStatement':
          out.push({ o: ops, s: 'compare', at: at(p) });
          return out;
        case 'ExpressionStatement':
          out.push({ o: ops, d: 'discarded' });
          return out;
        case 'ThrowStatement': {
          const tm = this.enclosingToolMethod(m, p);
          if (tm) { out.push({ o: ops, s: 'tool-throw', at: at(p) }); return out; }
          return out.concat(this.exceptionFrom(m, p, ops));
        }
        case 'IfStatement':
        case 'WhileStatement':
        case 'DoWhileStatement':
        case 'ForStatement':
        case 'SwitchStatement':
        case 'SwitchCase':
          out.push({ o: ops, s: 'compare', at: at(p) });
          return out;
        case 'ExportSpecifier': {
          const ename = p.exported.name ?? p.exported.value;
          out.push({ o: ops, exp: [m.seg.name, ename] });
          return out;
        }
        case 'ExportDefaultDeclaration':
          out.push({ o: ops, exp: [m.seg.name, 'default'] });
          return out;
        case 'YieldExpression':
          out.push({ o: ops, u: 'yielded from a generator', at: at(p) });
          return out;
        case 'ImportExpression':
        case 'ImportDeclaration':
        case 'ExportNamedDeclaration':
        case 'ExportAllDeclaration':
          out.push({ o: ops, d: 'module specifier' });
          return out;
        case 'PropertyDefinition':
          out.push({ o: ops, u: 'class field', at: at(p) });
          return out;
        case 'ClassBody':
        case 'MethodDefinition':
          out.push({ o: ops, u: 'class member', at: at(p) });
          return out;
        case 'JSXExpressionContainer':
          out.push({ o: ops, s: 'jsx-children', at: at(p) });
          return out;
        default:
          out.push({ o: ops, u: `unmodelled parent ${p.type}`, at: at(p) });
          return out;
      }
    }
    out.push({ o: ops, u: 'walk guard' });
    return out;
  }

  // Our value is the receiver of `value.method(...)`.
  methodOnValue(m, call, name, ops) {
    const at = m.cid(call);
    const out = [];
    if (name == null) return [{ o: [...ops, '-*'], called: at }, { o: [...ops, '~*'], u: 'computed method on value', at }];
    if (COMPARE_METHODS.has(name)) {
      // A callback receiving the elements still sees the value.
      const cb = call.arguments[0];
      if ((name === 'some' || name === 'every' || name === 'findIndex' || name === 'findLastIndex') && isFn(cb)) {
        out.push({ o: [...ops, 'K'], t: `P${m.abs(cb)}.0`, cs: at, hof: name });
      }
      out.push({ o: ops, s: 'compare', at });
      return out;
    }
    if (name === 'join') return this.flowUp(m, call, [...ops, 'J']);
    if (name === 'split') return this.flowUp(m, call, [...ops, 'S', '+[]']);
    if (STRING_PASSTHROUGH.has(name) && !(name === 'sort' && call.arguments.length && false)) {
      if ((name === 'filter' || name === 'find' || name === 'sort') && isFn(call.arguments[0])) {
        out.push({ o: [...ops, 'K'], t: `P${m.abs(call.arguments[0])}.0`, cs: at, hof: 'forEach' });
      }
      return out.concat(this.flowUp(m, call, ops));
    }
    if (POP_ELEMENT.has(name)) {
      if ((name === 'find' || name === 'findLast') && isFn(call.arguments[0])) {
        out.push({ o: [...ops, 'K'], t: `P${m.abs(call.arguments[0])}.0`, cs: at, hof: 'forEach' });
      }
      return out.concat(this.flowUp(m, call, [...ops, '-[]']));
    }
    if (name === 'map' || name === 'flatMap' || name === 'forEach' || name === 'reduce' || name === 'reduceRight') {
      const cb = call.arguments[0];
      const pidx = name === 'reduce' || name === 'reduceRight' ? 1 : 0;
      if (isFn(cb)) out.push({ o: [...ops, 'K'], t: `P${m.abs(cb)}.${pidx}`, cs: at, hof: name });
      else if (cb && cb.type === 'Identifier') {
        const v = m.varOf.get(cb);
        if (v) out.push({ o: [...ops, 'K'], cb: m.varKey(v), i: pidx, cs: at, hof: name });
        else out.push({ o: ops, u: `.${name} with unresolvable callback`, at });
      } else out.push({ o: ops, u: `.${name} with unresolvable callback`, at });
      if (name === 'reduce' && call.arguments[1] == null) out.push(...this.flowUp(m, call, [...ops, '-[]']));
      return out;
    }
    if (name === 'then') {
      const cb = call.arguments[0];
      if (isFn(cb)) out.push({ o: ops, t: `P${m.abs(cb)}.0`, cs: at, hof: 'then' });
      else out.push({ o: ops, u: '.then with unresolvable callback', at });
      return out;
    }
    if (name === 'get') return this.flowUp(m, call, [...ops, '-*']);
    if (name === 'keys' || name === 'values' || name === 'entries') return this.flowUp(m, call, [...ops, '-*', '+[]']);
    if (CONTAINER_IN.has(name) || name === 'delete' || name === 'clear') return [{ o: ops, d: `container .${name}` }];
    if (ZOD_CHAIN.has(name)) return this.flowUp(m, call, [...ops, 'Z']);
    if (name === 'bind') return this.flowUp(m, call, ops);
    if (name === 'call' || name === 'apply') return [{ o: ops, called: at, via: name }];
    // `container.k(...)` where our value sits under `k` invokes it; the same
    // call on a string is a method we do not model.
    return [{ o: [...ops, '-' + name], called: at }, { o: [...ops, '~' + name], u: `method .${name} on value`, at }];
  }

  // Our value is argument `i` of call `p`.
  argOutcome(m, p, i, ops, spread = false) {
    const at = m.cid(p);
    const callee = p.callee.type === 'ChainExpression' ? p.callee.expression : p.callee;
    const isNew = p.type === 'NewExpression';
    if (callee.type === 'Identifier') {
      const v = m.varOf.get(callee);
      if (!v) {
        const g = callee.name;
        if (ERROR_CTORS.has(g)) return i === 0 ? this.flowUp(m, p, [...ops, '+message@0']) : [{ o: ops, s: 'compare', at }];
        if (STRINGIFY_GLOBALS.has(g)) return this.flowUp(m, p, [...ops, 'S']);
        if (g === 'Promise' || g === 'Boolean' || g === 'Number' || g === 'parseInt' || g === 'parseFloat' || g === 'isNaN' || g === 'Symbol' || g === 'RegExp') return [{ o: ops, s: 'compare', at }];
        if (g === 'setTimeout' || g === 'setInterval' || g === 'queueMicrotask' || g === 'setImmediate') return [{ o: ops, d: 'timer' }];
        if (g === 'Set' || g === 'Map' || g === 'WeakMap' || g === 'WeakSet') return this.flowUp(m, p, ops);
        if (g === 'URL' || g === 'Date' || g === 'BigInt') return [{ o: ops, s: 'compare', at }];
        return [{ o: ops, u: `call of global ${g}`, at }];
      }
      const bind = m.varKey(v);
      const a0 = p.arguments[0];
      const extra = {};
      if (a0 && a0.type === 'Literal' && typeof a0.value === 'string' && /^tengu_/.test(a0.value)) extra.tengu = 1;
      if (i === 0 || i === 1) {
        if (a0 && a0.type === 'Identifier') { const av = m.varOf.get(a0); if (av) extra.a0 = m.varKey(av); }
        else if (a0 && isFn(a0)) extra.a0f = m.abs(a0);
        else if (a0 && a0.type === 'Literal') extra.a0s = 1;
      }
      const a1 = p.arguments[1];
      if (a1 && a1.type === 'ObjectExpression') extra.a1 = this.shapeOf(m, a1);
      else if (a1) extra.a1 = -1;
      const dp = p.parent;
      if (p.arguments.length === 1 && dp && dp.type === 'VariableDeclarator' && dp.init === p && dp.id.type === 'Identifier') {
        const wv = m.varOf.get(dp.id);
        if (wv) extra.wrapInto = m.varKey(wv);
      }
      return [{ o: ops, ca: bind, i, cs: at, isNew: isNew || undefined, cn: callee.name, ...(spread ? { spread: 1 } : {}), ...extra }];
    }
    if (isFn(callee)) return [{ o: ops, t: `P${m.abs(callee)}.${i}`, cs: at, iife: 1 }];
    if (callee.type === 'Super') {
      const ctor = enclosingFn(p);
      const cls = ctor && ctor.parent && ctor.parent.type === 'MethodDefinition' ? ctor.parent.parent.parent : null;
      if (i === 0 && cls && this.classTarget(m, cls)?.errorClass) return [{ o: [...ops, '+message'], superOf: m.abs(ctor) }];
      return [{ o: ops, u: 'argument of super()', at }];
    }
    if (callee.type === 'MemberExpression') {
      const name = memberName(callee);
      const obj = callee.object;
      if (obj.type === 'Identifier' && !m.varOf.get(obj)) {
        if (obj.name === 'console') return [{ o: ops, s: 'console', at }];
        if (obj.name === 'JSON' && name === 'stringify') return this.flowUp(m, p, [...ops, 'S*']);
        if (obj.name === 'JSON') return [{ o: ops, s: 'compare', at }];
        if (obj.name === 'Object' && ['freeze', 'assign', 'getOwnPropertyDescriptors', 'defineProperties', 'create', 'setPrototypeOf', 'seal', 'preventExtensions'].includes(name)) return this.flowUp(m, p, ops);
        if (obj.name === 'Object' && name === 'fromEntries') return this.flowUp(m, p, [...ops, '-[]', '-[]', '+*']);
        if (obj.name === 'Object' && (name === 'keys' || name === 'getOwnPropertyNames' || name === 'hasOwn' || name === 'is')) return [{ o: ops, s: 'compare', at }];
        if (obj.name === 'Object' && (name === 'values' || name === 'entries')) return this.flowUp(m, p, [...ops, '-*', '+[]']);
        if (obj.name === 'Array' && (name === 'from' || name === 'of')) return this.flowUp(m, p, name === 'of' ? [...ops, '+[]'] : ops);
        if (obj.name === 'Promise' && (name === 'resolve' || name === 'all' || name === 'allSettled' || name === 'race' || name === 'any')) return this.flowUp(m, p, ops);
        if (obj.name === 'Promise' && name === 'reject') return [{ o: ops, u: 'Promise.reject', at }];
        if (obj.name === 'String' && name === 'raw') return this.flowUp(m, p, ops);
        if (obj.name === 'Math' || obj.name === 'Number' || obj.name === 'Symbol' || obj.name === 'Date') return [{ o: ops, s: 'compare', at }];
        if ((obj.name === 'Object' && ['isExtensible', 'isFrozen', 'isSealed', 'getPrototypeOf', 'getOwnPropertySymbols'].includes(name)) || (obj.name === 'Array' && name === 'isArray') || (obj.name === 'Reflect' && ['has', 'ownKeys', 'getPrototypeOf'].includes(name))) return [{ o: ops, s: 'compare', at }];
        if (obj.name === 'Object' || obj.name === 'Array' || obj.name === 'Reflect') return [{ o: ops, u: `${obj.name}.${name}`, at }];
        if (obj.name === 'Buffer') return name === 'from' || name === 'concat' ? this.flowUp(m, p, ops) : [{ o: ops, s: 'compare', at }];
      }
      if (obj.type === 'MemberExpression' && obj.object.type === 'Identifier' && obj.object.name === 'process' && !m.varOf.get(obj.object)) {
        const s = memberName(obj);
        if ((s === 'stdout' || s === 'stderr') && name === 'write') return [{ o: ops, s: 'stdio', at }];
        if (s === 'env') return [{ o: ops, s: 'compare', at }];
      }
      if (name && i === 0 && (CALLBACK_RETURNS[name] !== undefined || HOF_PASSTHROUGH.has(name) || HOF_DISCARD.has(name))) {
        return [{ o: ops, hofArg: name, cs: at }];
      }
      if (name === 'createElement') {
        if (i >= 2) return [{ o: ops, s: 'jsx-children', at }];
        if (i === 0) return [{ o: ops, s: 'compare', at }];
        return [{ o: ops, s: 'jsx-prop', at }];
      }
      if (name === 'write' || name === 'writeSync' || name === 'end') {
        const src = m.snippet(callee, 0, 0);
        if (/std(out|err)/.test(src)) return [{ o: ops, s: 'stdio', at }];
        const a0 = p.arguments[0];
        if (i === 1 && a0 && a0.type === 'Literal' && (a0.value === 'stdout' || a0.value === 'stderr')) return [{ o: ops, s: 'stdio', at }];
      }
      if (name === 'describe' && i === 0) {
        return this.flowUp(m, p, [...ops, 'D']);
      }
      if (name && ZOD_CHAIN.has(name) && name !== 'describe') {
        // A schema passed to .or/.and/.extend joins the receiver schema.
        return this.flowUp(m, p, [...ops, 'Z']);
      }
      if (name && TEXT_PASSTHROUGH_CALLS.has(name)) return this.flowUp(m, p, [...ops, 'S']);
      if (name && CLI_HELP.has(name)) return [{ o: ops, s: 'cli-help', at }];
      if (name === 'description' || name === 'command' || name === 'name') {
        const src = this.code.slice(m.abs(callee.object), m.abs(callee.object) + Math.min(400, callee.object.end - callee.object.start));
        if (CLI_CHAIN.test(src) || /new [$\w]+\(/.test(src)) return [{ o: ops, s: 'cli-help', at }];
      }
      if (name && CONTAINER_IN.has(name)) {
        const recv = callee.object;
        const op = name === 'set' ? (i <= 1 ? '+*' : null) : '+[]';
        if (op == null) return [{ o: ops, s: 'compare', at }];
        if (recv.type === 'Identifier') {
          const v = m.varOf.get(recv);
          if (v) return [{ o: [...ops, op], t: 'B' + m.varKey(v) }];
        }
        if (recv.type === 'MemberExpression' && recv.object.type === 'Identifier') {
          const v = m.varOf.get(recv.object);
          const k = memberName(recv);
          if (v) return [{ o: [...ops, op, '+' + (k ?? '*')], t: 'B' + m.varKey(v) }];
        }
        if (recv.type === 'ArrayExpression' || recv.type === 'ObjectExpression') return this.flowUp(m, recv, [...ops, op]);
        return [{ o: ops, u: `.${name} into a non-local container`, at }];
      }
      if (name === 'concat') return this.flowUp(m, p, ops);
      if (name === 'replace' || name === 'replaceAll') return i === 1 ? this.flowUp(m, p, [...ops, 'S']) : [{ o: ops, s: 'compare', at }];
      if (name === 'join' || name === 'delete' || COMPARE_METHODS.has(name)) return [{ o: ops, s: 'compare', at }];
      if (name === 'call' && callee.object.type === 'Identifier') {
        const v = m.varOf.get(callee.object);
        if (v && i >= 1) return [{ o: ops, ca: m.varKey(v), i: i - 1, cs: at }];
      }
      // `ns.fn(x)` on a namespace import resolves through the export table.
      if (obj.type === 'Identifier' && name) {
        const v = m.varOf.get(obj);
        const key = v ? m.varKey(v) : null;
        const spec = key != null ? this.importSpec.get(key) : null;
        if (spec && spec[1] === '*') {
          const t = this.resolveExport(spec[0], name);
          if (t != null) return [{ o: ops, ca: t, i, cs: at }];
        }
      }
      return [{ o: ops, dc: at, i, callee: name ? `.${name}` : 'computed', ...this.dcExtra(m, p) }];
    }
    return [{ o: ops, dc: at, i, callee: callee.type, ...this.dcExtra(m, p) }];
  }

  dcExtra(m, p) {
    const a1 = p.arguments[1];
    if (a1 && a1.type === 'ObjectExpression') return { a1: this.shapeOf(m, a1) };
    if (a1) return { a1: -1 };
    return {};
  }

  // ----- query interpreter ---------------------------------------------------
  // Applies path operations. Returns the new path, or null when the value is
  // not carried along this branch (popping a key it is not stored under).
  static applyOp(path, op) {
    // '*' is an unknown key (computed member, Map entry); it stands for any
    // property and for an array slot, so it never kills a branch by mismatch.
    const top = path.length ? path[path.length - 1] : null;
    const isSlot = t => t === '[]' || t === '*';
    if (op === 'S' || op === 'S*') {
      // String conversion: an array joins (its elements survive), an object
      // keeps its fields only under JSON.stringify.
      if (path.every(isSlot) || op === 'S*') return [];
      // An Error stringifies to "Name: message".
      if (path.length === 1 && path[0] === 'message') return [];
      return null;
    }
    if (op === 'J' || op === 'K') {
      if (path.length && isSlot(top)) return path.slice(0, -1);
      return path.length ? null : path;
    }
    if (op === 'D') return path.length ? null : ['description'];
    if (op === 'Z') return path.length ? path : null;
    if (op[0] === '+') return [...path, op.slice(1).split('@')[0]];
    if (op[0] === '~') return path.length ? null : path;
    if (op[0] === '-') {
      const k = op.slice(1);
      // Indexing the value itself (`s[0]`, a destructured entry pair) keeps
      // it alive: dropping it here would turn imprecision into a dead end.
      if (!path.length) return k === '*' || k === '[]' ? path : null;
      // Numeric keys (`c[17]`, the React compiler's memo slots) are exact
      // among themselves and match an array slot.
      if (k === '*' || top === '*' || top === k || (k === '[]' && (isSlot(top) || isIndex(top))) || (isIndex(k) && top === '[]')) return path.slice(0, -1);
      return null;
    }
    return path;
  }

  // Sink fired by pushing the value (with `path` BEFORE the push) under key k
  // of object shape sh. Mode 'str' = tracing a string; 'fn' = a function value.
  shapeSink(path, k, shAbs, isMethod, mode) {
    const sh = this.shapes.get(shAbs);
    if (!sh) return null;
    const v = sh.v || {};
    if (mode === 'fn') {
      if (path.length) return null;
      // CC-specific method names are evidence on their own; generic ones
      // (prompt/description/call) need the tool shape around them.
      if (DISTINCTIVE_METHODS[k]) return DISTINCTIVE_METHODS[k];
      if (sh.tool) {
        if (k === 'call') return `role:tool-call@${shAbs}`;
        if (k === 'create') return `role:tool-create@${shAbs}`;
        if (TOOL_MODEL_METHODS[k]) return TOOL_MODEL_METHODS[k];
        if (TOOL_UI_METHODS.has(k) || /^render/.test(k)) return 'tool-ui-method';
        if (k === 'checkPermissions') return 'pass';
      }
      if (COMMAND_TYPES.has(v.type)) {
        if (k === 'getPromptForCommand') return 'command-prompt';
        if (k === 'call') return v.type === 'local' ? 'role:local-call' : v.type === 'local-jsx' ? 'role:local-jsx-call' : null;
        if (k === 'description' || k === 'userFacingName' || k === 'argumentHint') return k === 'description' ? 'command-description' : 'tool-ui-method';
      }
      return null;
    }
    if (path.length === 0) {
      if (v.type === 'text' && k === 'text') return 'text-block';
      if (v.type === 'text' && k === 'value') return 'local-command-text';
      if (v.type === 'tool_result' && k === 'content') return 'tool-result-content';
      if ((v.behavior === 'ask' || v.behavior === 'deny') && k === 'message') return 'permission-message';
      if ((v.role === 'user' || v.role === 'assistant' || v.role === 'system') && k === 'content') return 'api-message';
      if (v.isMeta === true && k === 'content') return 'meta-message';
      if (k === 'children') return 'jsx-children';
      if (sh.tool && isMethod) return null;
      if (COMMAND_TYPES.has(v.type) && k === 'description') return 'command-description';
    }
    if (path.length && path[0] === 'description') {
      if (k === 'inputSchema') return 'tool-input-schema';
      if (sh.z) return 'sdk-control-schema';
    }
    if (path.length === 1 && path[0] === '[]' && v.type === 'tool_result' && k === 'content') return 'tool-result-content';
    return null;
  }

  // Every call site that invokes a local-jsx command's onDone.
  ondoneCallSites() {
    if (this.ondoneSites) return this.ondoneSites;
    this.scan();
    const sites = new Map();
    const callFns = [];
    for (const [mod, c] of this.commandModules) {
      if (c.type !== 'local-jsx') continue;
      const b = this.resolveExport(mod, 'call');
      if (b == null) continue;
      const r = this.resolveFn(b);
      if (r && r.fn != null) callFns.push([r.fn, c.name]);
    }
    for (const [fn, c] of this.inlineCommandFns) if (c.type === 'local-jsx' && c.key === 'call') callFns.push([fn, c.name]);
    this.ondoneSites = sites;
    for (const [fn, name] of callFns) {
      const r = this.run(`P${fn}.0`, 'fn', { maxStates: 3000 });
      for (const cs of r.called) if (!sites.has(cs)) sites.set(cs, name);
    }
    return sites;
  }

  // Where a function's RETURN value goes when we do not know the call site:
  // every direct and indirect invocation plus any framework role.
  callersOf(fnAbs) {
    if (this.callersMemo.has(fnAbs)) return this.callersMemo.get(fnAbs);
    this.callersMemo.set(fnAbs, { called: [], roles: [], hofs: [], unresolved: ['recursive'], jsxType: [] });
    this.scan();
    const res = this.run(`V${fnAbs}`, 'fn', { maxStates: 2500 });
    const inline = this.inlineCommandFns.get(fnAbs);
    if (inline) res.roles.push(inline.key === 'getPromptForCommand' ? 'command-prompt' : inline.type === 'local' ? 'role:local-call' : 'role:local-jsx-call');
    this.callersMemo.set(fnAbs, res);
    return res;
  }

  // Core BFS over outcome graph.
  //   mode 'str': trace a string value; returns sinks/unresolved.
  //   mode 'fn' : trace a function value; returns call sites and roles.
  run(startKey, mode, { maxStates = 12000, maxDepth = 22 } = {}) {
    const res = { sinks: [], unresolved: [], called: [], roles: [], hofs: [], jsxType: [], states: 0 };
    const seen = new Set();
    const queue = [{ key: startKey, path: [], stack: [], depth: 0, trail: [], ec: null, guarded: false }];
    const sinkSeen = new Set();
    const perKind = new Map();
    const addSink = (kind, atOff, st, extra = {}) => {
      const id = kind + '@' + (atOff ?? '');
      if (sinkSeen.has(id)) return;
      sinkSeen.add(id);
      const n = (perKind.get(kind) || 0) + 1;
      perKind.set(kind, n);
      if (n > 6) { res.sinkOverflow = res.sinkOverflow || {}; res.sinkOverflow[kind] = (res.sinkOverflow[kind] || 0) + 1; return; }
      let facing = SINKS[kind] ? SINKS[kind].facing : null;
      // A model route that passed an unverifiable `instanceof` guard is
      // evidence, not proof.
      if (facing === 'model' && st.guarded) { facing = null; extra = { ...extra, guarded: true }; }
      res.sinks.push({ kind, facing, at: atOff ?? null, depth: st.depth, via: st.trail.slice(-(this.viaLen || 8)), ...extra });
    };
    const addU = (reason, atOff, st) => {
      if (res.unresolved.length < 30) res.unresolved.push({ reason, at: atOff ?? null, depth: st.depth, via: st.trail.slice(-6) });
      else res.unresolvedOverflow = (res.unresolvedOverflow || 0) + 1;
    };
    while (queue.length) {
      const st = queue.shift();
      // The whole call stack is part of the state: two contexts that share
      // the innermost call site still return to different callers.
      const sig = `${st.key}|${st.path.join('/')}|${st.stack.map(x => x.cs).join(',')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (++res.states > maxStates) { addU('state budget exhausted', null, st); break; }
      if (st.depth > maxDepth) { addU('depth exhausted', null, st); continue; }
      let ec = st.ec;
      let guarded = st.guarded;
      const push = (key, path, stack, depthInc, label) =>
        queue.push({ key, path, stack, depth: st.depth + depthInc, trail: label ? [...st.trail, label] : st.trail, ec, guarded });

      // Function return: continue at the matching call site, or every caller.
      if (st.key[0] === 'R') {
        const fnAbs = Number(st.key.slice(1));
        const top = st.stack[st.stack.length - 1];
        if (top && top.fn === fnAbs) {
          const rest = st.stack.slice(0, -1);
          if (top.hof) {
            const ret = CALLBACK_RETURNS[top.hof];
            if (ret === undefined) continue; // forEach/filter/...: return value is not the result
            const path = ret ? RouteProgram.applyOp(st.path, ret) : st.path;
            push('C' + top.cs, path, rest, 0, `ret→${top.hof}@${top.cs}`);
          } else push('C' + top.cs, st.path, rest, 0, `ret@${top.cs}`);
          continue;
        }
        // Framework role of the function itself (inline command fns etc.).
        const cal = this.callersOf(fnAbs);
        if (!cal.called.length && !cal.roles.length && !cal.hofs.length && !cal.jsxType.length && !cal.unresolved.length) {
          if (mode === 'str') addU('return value: no caller found', fnAbs, st);
          else res.unresolved.push('no caller found');
        }
        for (let role of cal.roles) {
          // `create(){return {call, validateInput}}` on a tool definition:
          // the method is the key the value sits under.
          if (role.startsWith('role:tool-create@')) {
            const k = st.path[st.path.length - 1];
            const shAbs = role.split('@')[1];
            if (mode === 'fn') {
              if (k === 'call') res.roles.push(`role:tool-call@${shAbs}`);
              else if (k && (DISTINCTIVE_METHODS[k] || TOOL_MODEL_METHODS[k])) res.roles.push(DISTINCTIVE_METHODS[k] || TOOL_MODEL_METHODS[k]);
              else if (k && TOOL_UI_METHODS.has(k)) res.roles.push('tool-ui-method');
              else if (k !== 'checkPermissions') res.unresolved.push(`tool create() member ${k}`);
            } else addU('returned from a tool create()', fnAbs, st);
            continue;
          }
          if (role.startsWith('role:tool-call@')) {
            if (mode !== 'str') { res.roles.push(role); continue; }
            // The framework hands `data` to the same tool's
            // mapToolResultToToolResultBlockParam.
            const sh = this.shapes.get(Number(role.split('@')[1]));
            const mapper = sh && sh.f && sh.f.mapToolResultToToolResultBlockParam;
            if (st.path.length && st.path[st.path.length - 1] === 'data' && mapper != null) {
              push(`P${mapper}.0`, st.path.slice(0, -1), [], 1, `tool data→mapper@${mapper}`);
            } else addSink('tool-call-data', fnAbs, st, { path: st.path.join('.') });
            continue;
          }
          if (mode !== 'str') { res.roles.push(role); continue; }
          if (role === 'role:local-call') {
            if (st.path.length === 0) addSink('local-command-return', fnAbs, st);
            else addSink('local-command-return', fnAbs, st, { path: st.path.join('.') });
          } else if (role === 'role:local-jsx-call') addSink('local-jsx-element', fnAbs, st);
          else if (role !== 'pass') addSink(role, fnAbs, st);
        }
        for (const cs of cal.called) push('C' + cs, st.path, [], 1, `ret→caller@${cs}`);
        for (const h of cal.hofs) {
          if (h.hof === 'setState') { push('B' + h.state, st.path, [], 1, `updater→state ${h.state}`); continue; }
          const ret = CALLBACK_RETURNS[h.hof];
          if (ret === undefined) continue;
          const path = ret ? RouteProgram.applyOp(st.path, ret) : st.path;
          if (path) push('C' + h.cs, path, [], 1, `ret→${h.hof}@${h.cs}`);
        }
        for (const cs of cal.jsxType) if (mode === 'str') addSink('jsx-render', cs, st);
        for (const u of cal.unresolved) {
          const why = typeof u === 'string' ? u : u.reason;
          if (mode === 'str') addU(`return value: ${why}`, fnAbs, st);
          else if (res.unresolved.length < 30) res.unresolved.push(why);
        }
        continue;
      }

      // `X = wrap(fn)`: only direct calls of X are taken as calls of fn.
      const outs = st.key[0] === 'W' ? this.outcomes('B' + st.key.slice(1)).filter(o => o.called != null && !(o.o || []).length) : this.outcomes(st.key);
      if (this.debug) this.debug(st, outs);
      for (const oc of outs) {
        let path = st.path;
        let killed = false;
        let firedSink = null;
        ec = st.ec;
        guarded = st.guarded;
        if (oc.g) {
          let skip = false;
          for (const gk of oc.g) {
            const isA = ec == null ? null : this.classIsA(ec, gk);
            if (isA === false) { skip = true; break; }
            if (isA == null) guarded = true;
          }
          if (skip) continue;
        }
        const ops = oc.o || [];
        for (let oi = 0; oi < ops.length; oi++) {
          const op = ops[oi];
          if (op[0] === '+' && op.includes('@')) {
            const [, k, sh, meth] = op.match(/^\+([^@]*)@(-?\d+)(@m)?$/) || [];
            if (sh && Number(sh) > 0) {
              let s = this.shapeSink(path, k, Number(sh), !!meth, mode);
              // A text block inside a synthetic API-error assistant message
              // is not proven to reach the model.
              if (s === 'text-block' && ops.slice(oi + 1).some(o2 => {
                const mm = o2.match(/^\+[^@]*@(\d+)/);
                const sh2 = mm && this.shapes.get(Number(mm[1]));
                return sh2 && sh2.v && sh2.v.isApiErrorMessage === true;
              })) s = 'api-error-text';
              if (s) { firedSink = { kind: s, at: Number(sh) }; break; }
            }
          }
          if (op === 'D' && mode === 'str' && path.length === 0) {
            const lit = st.key[0] === 'L' ? Number(st.key.slice(1)) : null;
            if (lit != null && this.settingsIndex.has(lit)) {
              const hit = this.settingsIndex.get(lit);
              firedSink = { kind: hit.internal ? 'settings-describe-internal' : 'settings-describe', at: lit };
              break;
            }
          }
          if (op === '+message@0') ec = 'Error';
          path = RouteProgram.applyOp(path, op);
          if (path == null) { killed = true; break; }
        }
        if (firedSink) {
          if (mode === 'str') addSink(firedSink.kind, firedSink.at, st);
          else if (firedSink.kind === 'pass') { /* checkPermissions: shape sinks decide */ }
          else res.roles.push(firedSink.kind);
          continue;
        }
        if (killed) continue;
        if (oc.d) continue;
        if (oc.u) { if (mode === 'str') addU(oc.u, oc.at, st); else res.unresolved.push(oc.u); continue; }
        if (oc.s) {
          if (mode === 'str') addSink(oc.s, oc.at, st, oc.s === 'jsx-prop' ? {} : {});
          continue;
        }
        if (oc.called != null) {
          if (mode === 'fn' && path.length === 0) res.called.push(oc.called);
          continue;
        }
        if (oc.superOf != null) {
          // super(msg) in an Error subclass: the message lands on the object
          // the `new` expression we came in through produces.
          const top = st.stack[st.stack.length - 1];
          if (top && top.fn === oc.superOf) { if (top.cls != null) ec = top.cls; push('C' + top.cs, path, st.stack.slice(0, -1), 0, `super→new@${top.cs}`); }
          else if (mode === 'str') addU('Error subclass constructed at an unknown site', oc.superOf, st);
          continue;
        }
        if (oc.thr != null) {
          // Exception leaving function thr: back to the call site we came
          // in through, or to every caller; a tool call() turns it into an
          // error tool_result.
          const top = st.stack[st.stack.length - 1];
          if (top && top.fn === oc.thr && !top.hof) { push('T' + top.cs, path, st.stack.slice(0, -1), 0, `throw→${top.cs}`); continue; }
          const cal = this.callersOf(oc.thr);
          let any = false;
          for (const role of cal.roles) {
            any = true;
            if (mode !== 'str') continue;
            if (role.startsWith('role:tool-call@') || role === 'tool-validate') addSink('tool-throw', oc.thr, st);
            else if (role === 'role:tool-create@') addU('thrown from a tool create()', oc.thr, st);
            else addSink('throw', oc.thr, st, { role });
          }
          for (const cs of cal.called) { any = true; push('T' + cs, path, [], 1, `throw→caller@${cs}`); }
          if (!any && mode === 'str') addSink('throw', oc.thr, st);
          continue;
        }
        if (oc.hofArg) {
          // A function handed to map/then/useMemo/...: the runtime calls it.
          if (mode === 'fn' && path.length === 0) {
            if (HOF_PASSTHROUGH.has(oc.hofArg)) push('C' + oc.cs, path, st.stack, 0, `${oc.hofArg}@${oc.cs}`);
            else if (CALLBACK_RETURNS[oc.hofArg] !== undefined) res.hofs.push({ hof: oc.hofArg, cs: oc.cs });
          } else if (mode === 'str') addU(`passed as the callback of .${oc.hofArg}`, oc.cs, st);
          continue;
        }
        if (oc.exp) {
          const [mod, name] = oc.exp;
          const imps = this.importers.get(`${mod}|${name}`) || [];
          for (const b of imps) push('B' + b, path, st.stack, 0, `import ${name}`);
          const cmd = this.commandModules.get(mod);
          if (cmd && name === 'call') {
            const role = cmd.type === 'local' ? 'role:local-call' : cmd.type === 'local-jsx' ? 'role:local-jsx-call' : null;
            if (mode === 'fn' && role) res.roles.push(role);
          } else if (cmd && name === 'getPromptForCommand' && mode === 'fn') res.roles.push('command-prompt');
          // Other dynamic importers read the namespace object: follow it
          // with the export name on the path.
          for (const site of this.dynSites.get(mod) || []) push('N' + site, [...path, name], st.stack, 0, `import("${mod.split('/').pop()}").${name}`);
          // Re-exports of this name are importers too: handled when the
          // re-exporting module's own export specifier reads its import.
          continue;
        }
        if (oc.t) {
          const isP = oc.t[0] === 'P';
          let stack = st.stack;
          if (isP && oc.cs != null) {
            const fnAbs = Number(oc.t.slice(1).split('.')[0]);
            stack = [...st.stack, { cs: oc.cs, fn: fnAbs, hof: oc.hof }].slice(-8);
          }
          push(oc.t, path, stack, isP ? 1 : 0, isP ? `arg→${oc.t}` : null);
          continue;
        }
        if (oc.cb != null) {
          // `.map(fnBinding)`: the element enters the named function.
          const r = this.resolveFn(oc.cb);
          if (r && r.fn != null) push(`P${r.fn}.${oc.i}`, path, [...st.stack, { cs: oc.cs, fn: r.fn, hof: oc.hof }].slice(-8), 1, `cb→${r.fn}`);
          else if (mode === 'str') addU(`.${oc.hof} with an unresolvable callback`, oc.cs, st);
          continue;
        }
        if (oc.ca != null) {
          const r = this.resolveFn(oc.ca);
          // Logger and telemetry by their public names or shape.
          const names = this.publicNames(oc.ca);
          if (oc.tengu) { if (mode === 'str') addSink('analytics', oc.cs, st); continue; }
          if (names && [...names].some(n => LOGGER_NAMES.test(n))) { if (mode === 'str') addSink('debug-log', oc.cs, st); continue; }
          if (mode === 'fn' && oc.wrapInto != null) push('W' + oc.wrapInto, path, st.stack, 0, `wrapped as ${oc.wrapInto}`);
          const targets = r ? (r.fns || (r.fn != null && !r.param ? [r.fn] : [])) : [];
          if (r && r.promise != null) {
            if (oc.i !== 0) continue;
            push((r.reject ? 'T' : 'C') + r.promise, path, [], 0, `${r.reject ? 'reject' : 'resolve'}@${r.promise}`);
            continue;
          }
          if (r && r.setter != null) {
            if (oc.i !== 0) continue;
            if (mode === 'str') push('B' + r.setter, path, [], 0, `setState→${r.setter}`);
            // A function handed to a state setter is an updater: React calls
            // it and its return value becomes the state.
            else if (path.length === 0) res.hofs.push({ hof: 'setState', cs: oc.cs, state: r.setter });
            else push('B' + r.setter, path, [], 0, `setState→${r.setter}`);
            continue;
          }
          const hook = targets.length === 1 ? this.fnFlags(targets[0]).hook : null;
          if (hook) {
            if (oc.i >= 1 && hook !== 'useReducer') continue; // dependency arrays
            if (hook === 'useState' || hook === 'useReducer' || hook === 'useOptimistic') { const p2 = RouteProgram.applyOp(path, '+[]'); if (p2) push('C' + oc.cs, p2, st.stack, 0, `${hook}@${oc.cs}`); continue; }
            if (hook === 'useRef') { push('C' + oc.cs, [...path, 'current'], st.stack, 0, `useRef@${oc.cs}`); continue; }
            if (hook === 'useCallback' || hook === 'useDeferredValue' || hook === 'use' || hook === 'useEffectEvent') { push('C' + oc.cs, path, st.stack, 0, `${hook}@${oc.cs}`); continue; }
            if (hook === 'useMemo') { if (mode === 'fn') res.hofs.push({ hof: 'useMemo', cs: oc.cs }); continue; }
            if (/^use(Layout|Insertion)?Effect$/.test(hook)) continue;
            if (hook === 'useContext' || hook === 'useId') { if (mode === 'str') addSink('compare', oc.cs, st); continue; }
            if (mode === 'str') addU(`React ${hook}`, oc.cs, st); else res.unresolved.push(`React ${hook}`);
            continue;
          }
          if (r && r.errorClass && !r.ctor) {
            if (oc.i === 0) {
              const p2 = RouteProgram.applyOp(path, '+message');
              ec = String(this.resolveImportAlias(oc.ca));
              if (p2) push('C' + oc.cs, p2, st.stack, 0, `new Error-subclass@${oc.cs}`);
            } else if (mode === 'str') addU(`argument ${oc.i} of Error subclass ${oc.cn}`, oc.cs, st);
            continue;
          }
          if (targets.length === 1 && this.fnFlags(targets[0]).jsx) {
            if (mode === 'fn' && oc.i === 0) { if (path.length === 0) res.jsxType.push(oc.cs); continue; }
            if (oc.i >= 2) { if (mode === 'str') addSink('jsx-children', oc.cs, st); else res.unresolved.push('function rendered as a JSX child'); continue; }
            if (oc.i === 0) { addSink('compare', oc.cs, st); continue; }
            // Props of a component: follow into it; an intrinsic is UI.
            if (oc.a0 != null) {
              const c = this.resolveFn(oc.a0);
              const cf = c ? (c.fns || (c.fn != null && !c.param ? [c.fn] : [])) : [];
              if (cf.length) { for (const f of cf) push(`P${f}.0`, path, [], 1, `props→${f}`); continue; }
            }
            if (oc.a0f != null) { push(`P${oc.a0f}.0`, path, [], 1, `props→${oc.a0f}`); continue; }
            if (mode === 'str') addSink('jsx-prop', oc.cs, st);
            else if (oc.a0s) { /* intrinsic element: a function prop is an event handler */ }
            else res.unresolved.push('function passed as a prop of an unresolvable component');
            continue;
          }
          if (targets.length) {
            for (const f of targets) {
              if (oc.spread) {
                const ri = this.fnFlags(f).rest;
                if (ri == null || ri < 0 || ri > oc.i) { if (mode === 'str') addU('spread into call arguments', oc.cs, st); else res.unresolved.push('spread into call arguments'); continue; }
              }
              if (this.fnFlags(f).zod && path.length && path[0] === 'description') {
                push('C' + oc.cs, path, st.stack, 0, `zod@${oc.cs}`);
                continue;
              }
              const stack = [...st.stack, { cs: oc.cs, fn: f, ...(r.errorClass ? { cls: String(this.resolveImportAlias(oc.ca)) } : {}) }].slice(-8);
              push(`P${f}.${oc.i}`, path, stack, 1, `arg${oc.i}→fn@${f}${r.wrapped ? ' (wrapper)' : ''}`);
            }
            continue;
          }
          if (r && r.param) {
            if (this.callbackTargets(r, st, oc, path, push, mode, mode === 'str' ? addU : (why) => res.unresolved.push(why))) continue;
            if (mode === 'str') this.dynamicCallSink(oc, path, st, addSink, addU);
            else res.unresolved.push('passed to a parameter callback');
            continue;
          }
          if (r && (r.inherited || r.noCtor)) { if (mode === 'str') addU(`new ${oc.cn} (constructor not resolvable)`, oc.cs, st); else res.unresolved.push('passed to a class without a constructor'); continue; }
          if (mode === 'str') addU(`call of ${oc.cn || 'a binding'} (${this.whyNotFn(oc.ca)})`, oc.cs, st);
          else res.unresolved.push('passed to an unresolvable callee');
          continue;
        }
        if (oc.dc != null) {
          if (mode === 'str') this.dynamicCallSink(oc, path, st, addSink, addU);
          else res.unresolved.push(`passed to dynamic call ${oc.callee || ''}`);
          continue;
        }
      }
    }
    return res;
  }

  // The callee is parameter `index` of function F: whatever F's caller
  // passed there is what runs. Use the call site we came in through when we
  // know it, every caller of F otherwise. The local-jsx onDone sites win
  // (checked first by the caller) because the dispatcher, not a visible
  // caller, supplies that function.
  callbackTargets(r, st, oc, path, push, mode, addU) {
    if (r.fn == null || r.index == null) return false;
    const cs = oc.cs != null ? oc.cs : oc.dc;
    if (mode === 'str' && this.ondoneCallSites().has(cs)) return false;
    const top = [...st.stack].reverse().find(x => x.fn === r.fn);
    const cal = top ? null : this.callersOf(r.fn);
    // A component's props arrive as argument 1 of each JSX call that renders it.
    const sites = top ? [[top.cs, r.index]] : [
      ...cal.called.map(c => [c, r.index]),
      ...(r.index === 0 ? cal.jsxType.map(c => [c, 1]) : []),
    ];
    let any = false;
    let missing = 0;
    for (const [site, argIdx] of sites.slice(0, 40)) {
      const fns = this.argFnsAt(site, argIdx, r.key);
      if (!fns) { missing++; continue; }
      if (!fns.length) continue;
      for (const g of fns) {
        any = true;
        push(`P${g}.${oc.i}`, path, [...st.stack, { cs, fn: g }].slice(-8), 1, `callback→${g}`);
      }
    }
    if (any && (missing || sites.length > 40)) addU(`callback parameter: ${missing} caller argument(s) not resolvable`, cs, st);
    return any;
  }

  dynamicCallSink(oc, path, st, addSink, addU) {
    const cs = oc.cs != null ? oc.cs : oc.dc;
    const sites = this.ondoneCallSites();
    if (sites.has(cs)) {
      const sh = oc.a1 > 0 ? this.shapes.get(oc.a1) : null;
      const display = sh && sh.v ? sh.v.display : undefined;
      const cmd = sites.get(cs);
      if (oc.i === 0 && path.length === 0) {
        if (display === 'skip') addSink('local-jsx-skip', cs, st, { command: cmd });
        else if (display === 'system') addSink('local-jsx-system', cs, st, { command: cmd });
        else if (oc.a1 === -1) addU(`onDone of /${cmd} with a non-literal options argument`, cs, st);
        else addSink('local-jsx-ondone', cs, st, { command: cmd, display: display ?? null });
        return;
      }
      if (oc.i === 1 && path.length >= 1 && path[path.length - 1] === 'metaMessages') {
        if (display === 'skip') addSink('local-jsx-skip', cs, st, { command: cmd });
        else addSink('local-jsx-meta', cs, st, { command: cmd });
        return;
      }
      addU(`onDone of /${cmd} argument ${oc.i} under ${path.join('.') || '(value)'}`, cs, st);
      return;
    }
    addU(`passed to a dynamic call (${oc.callee || 'parameter/unknown callee'})`, cs, st);
  }

  // The emitting-function family of the literal at `abs`: its innermost
  // enclosing function, or — for a module-level constant — the function that
  // first reads it. Candidates sharing a family are ruled together.
  familyOf(abs) {
    if (this.offline) return { key: `offset:${abs}`, fn: null };
    const m = this.moduleAt(abs);
    if (m.failed) return { key: `module:${this.segIndexAt(abs)}`, fn: null };
    const lit = m.find(abs, x => x.type === 'Literal' || x.type === 'TemplateLiteral');
    let fn = lit ? enclosingFn(lit) : null;
    if (!fn && lit) {
      let n = lit;
      while (n.parent && n.parent.type !== 'VariableDeclarator' && !isFn(n.parent) && n.parent.type !== 'Program') n = n.parent;
      const decl = n.parent && n.parent.type === 'VariableDeclarator' ? n.parent : null;
      const v = decl && decl.id.type === 'Identifier' ? m.varOf.get(decl.id) : null;
      const read = v && v.references.find(r => r.isRead() && enclosingFn(r.identifier));
      if (read) fn = enclosingFn(read.identifier);
    }
    // Inline callbacks (`.map(x => …)`, `.then(…)`) belong to the function
    // that passes them.
    while (fn && fn.type !== 'FunctionDeclaration' && fn.parent && (fn.parent.type === 'CallExpression' || fn.parent.type === 'NewExpression') && fn.parent.callee !== fn) {
      const up = enclosingFn(fn);
      if (!up) break;
      fn = up;
    }
    if (!fn) return { key: `module:${m.seg.name}`, fn: null, module: m.seg.name };
    const head = this.code.slice(m.abs(fn), m.abs(fn) + 70).replace(/\s+/g, ' ');
    return { key: `fn:${m.abs(fn)}`, fn: m.abs(fn), module: m.seg.name, head };
  }

  // Public: route of the literal starting at `abs`.
  trace(abs, opts = {}) {
    const r = this.run('L' + abs, 'str', opts);
    return summarizeRoute(r);
  }

  // Serialisation: everything a later query needs, minus the bundle.
  toJSON() {
    return {
      format: SUMMARY_FORMAT,
      memo: [...this.memo],
      shapes: [...this.shapes],
      bindFn: [...this.bindFn],
      fnInfo: [...this.fnInfo],
      callers: [...this.callersMemo],
      argFns: [...this.argFnsMemo],
      classIsA: [...this.classMemo],
      ondone: this.ondoneSites ? [...this.ondoneSites] : null,
      settings: [...this.settingsIndex],
      scan: this.scanned ? {
        exportsOf: [...this.exportsOf].map(([k, v]) => [k, [...v]]),
        starExports: [...this.starExports],
        importers: [...this.importers],
        importSpec: [...this.importSpec],
        dynImported: [...this.dynImported],
        commandModules: [...this.commandModules],
        inlineCommandFns: [...this.inlineCommandFns],
        zodModules: [...this.zodModules],
        dynSites: [...this.dynSites],
        names: [...this.names].map(([k, v]) => [k, [...v]]),
      } : null,
    };
  }
  static fromJSON(json, code = null) {
    if (!json || json.format !== SUMMARY_FORMAT) throw new Error('route summary format mismatch');
    const p = Object.create(RouteProgram.prototype);
    p.code = code;
    if (code) {
      p.segments = splitModuleBundle(code) || [{ name: '<bundle>', start: 0, source: code }];
      p.segStarts = p.segments.map(s => s.start);
    } else {
      p.segments = null;
      p.segStarts = [];
    }
    p.lru = new Map();
    p.lruBytes = 0;
    p.lruMaxBytes = 16e6;
    p.memo = new Map(json.memo);
    p.shapes = new Map(json.shapes);
    p.bindFn = new Map(json.bindFn);
    p.fnInfo = new Map(json.fnInfo);
    p.callersMemo = new Map(json.callers);
    p.argFnsMemo = new Map(json.argFns || []);
    p.classMemo = new Map(json.classIsA || []);
    p.ondoneSites = json.ondone ? new Map(json.ondone) : null;
    p.settingsIndex = new Map(json.settings);
    p.stats = { parsed: 0 };
    const s = json.scan;
    p.scanned = !!s;
    if (s) {
      p.exportsOf = new Map(s.exportsOf.map(([k, v]) => [k, new Map(v)]));
      p.starExports = new Map(s.starExports);
      p.importers = new Map(s.importers);
      p.importSpec = new Map(s.importSpec);
      p.dynImported = new Set(s.dynImported);
      p.commandModules = new Map(s.commandModules);
      p.inlineCommandFns = new Map(s.inlineCommandFns);
      p.zodModules = new Set(s.zodModules);
      p.dynSites = new Map(s.dynSites);
      p.names = new Map(s.names.map(([k, v]) => [k, new Set(v)]));
    }
    return p;
  }
  // When loaded without the bundle, a node missing from the summary cannot be
  // computed; report that instead of guessing.
  get offline() { return !this.segments; }
}

// Offline programs answer only from the memo.
const origOutcomes = RouteProgram.prototype.outcomes;
RouteProgram.prototype.outcomes = function (key) {
  if (this.offline && !this.memo.has(key)) return [{ u: 'not in the cached summary (rerun with the bundle)' }];
  return origOutcomes.call(this, key);
};
const origResolve = RouteProgram.prototype.resolveFn;
RouteProgram.prototype.resolveFn = function (key) {
  if (this.offline && !this.bindFn.has(key)) return null;
  return origResolve.call(this, key);
};
const origFlags = RouteProgram.prototype.fnFlags;
RouteProgram.prototype.fnFlags = function (fn) {
  if (this.offline && !this.fnInfo.has(fn)) return { jsx: false, zod: false };
  return origFlags.call(this, fn);
};
const origCallers = RouteProgram.prototype.callersOf;
RouteProgram.prototype.callersOf = function (fn) {
  if (this.offline && !this.callersMemo.has(fn)) return { called: [], roles: [], hofs: [], jsxType: [], unresolved: ['not in the cached summary'] };
  return origCallers.call(this, fn);
};
const origOndone = RouteProgram.prototype.ondoneCallSites;
RouteProgram.prototype.ondoneCallSites = function () {
  if (this.offline && !this.ondoneSites) return new Map();
  return origOndone.call(this);
};

export function summarizeRoute(r) {
  const model = r.sinks.filter(s => s.facing === 'model');
  const ui = r.sinks.filter(s => s.facing === 'ui');
  const internal = r.sinks.filter(s => s.facing === 'internal');
  const open = r.sinks.filter(s => s.facing == null);
  const resolved = r.sinks.length > 0 && r.unresolved.length === 0 && open.length === 0 && !r.unresolvedOverflow;
  let verdict = null;
  if (model.length) verdict = 'model';
  else if (resolved) verdict = ui.length ? 'ui' : 'internal';
  return {
    verdict,
    resolved,
    sinks: r.sinks.map(s => ({ kind: s.kind, facing: s.facing, at: s.at, depth: s.depth, via: s.via, ...(s.command ? { command: s.command } : {}), ...(s.display !== undefined ? { display: s.display } : {}), ...(s.path ? { path: s.path } : {}) })),
    unresolved: r.unresolved.map(u => ({ reason: u.reason, at: u.at, depth: u.depth, via: u.via })),
    ...(r.unresolvedOverflow ? { unresolvedOverflow: r.unresolvedOverflow } : {}),
    ...(r.sinkOverflow ? { moreSinks: r.sinkOverflow } : {}),
    states: r.states,
    ...(r.sinks.length === 0 && r.unresolved.length === 0 ? { note: 'value is never emitted, compared or stored on any traced branch' } : {}),
  };
}

// ---------------------------------------------------------------------------
function patternIds(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p);
  else if (p.type === 'ObjectPattern') for (const x of p.properties) patternIds(x.type === 'RestElement' ? x.argument : x.value, out);
  else if (p.type === 'ArrayPattern') for (const x of p.elements) patternIds(x && x.type === 'RestElement' ? x.argument : x, out);
  else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
  else if (p.type === 'RestElement') patternIds(p.argument, out);
  return out;
}
function destructuredKey(pattern, idNode) {
  for (const p of pattern.properties) {
    if (p.type !== 'Property') continue;
    const v = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
    if (v === idNode) return propName(p);
  }
  return null;
}
function enclosingFn(n) {
  for (let x = n.parent; x; x = x.parent) if (isFn(x)) return x;
  return null;
}
function walkPlain(node, visit, stop) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    visit(n);
    if (stop && n !== node && stop(n)) continue;
    for (const key in n) {
      if (key === 'parent') continue;
      const c = n[key];
      if (!c || typeof c !== 'object') continue;
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') stack.push(x); }
      else if (typeof c.type === 'string') stack.push(c);
    }
  }
}
