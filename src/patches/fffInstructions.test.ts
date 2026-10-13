import { describe, expect, it, vi } from 'vitest';
import {
  FFF_PROJECT_GUIDANCE,
  normalizeFffAutoMode,
  normalizeFffPrompt,
  writeFffInstructions,
} from './fffInstructions';

const API_SITE =
  'let $wire=$identity($merge($selected.systemPrompt,$routing.systemContext)),$unused,$other,$entries,$copies,$record=()=>{let $next=$extra($rows,$entries,{options:$current.options,querySource:$source,stamp:$stamp,toolInputCopies:$copies});return $next};';
const API =
  'async function*$query($input,$events,$commands,$runner){let{systemPrompt:$base,userContext:$user,systemContext:$environment,canUseTool:$permission}=$input;' +
  'let $current=$input.toolUseContext,$selected=$input.snapshot??{systemPrompt:$base},$routing={systemContext:$environment},$rows=[],$source="fixture",$stamp={};' +
  API_SITE +
  'yield{systemPrompt:$wire,tools:$current.options.tools,snapshot:$selected};}';
const CONTEXT_SITE =
  'let $counted=$snapshot?.systemPrompt??$default,$descriptions=$tools?.toolDescriptions,$schemas=$tools?.toolEntries;';
const CONTEXT =
  ';async function $context($messages,$model,$permissions,$visible,$agents,$details){let{session:$session,terminalWidth:$width,toolUseContext:$current,mainThreadAgentDefinition:$agent}=$details;' +
  'let $snapshot=$details.snapshot,$default=$details.prompt,$tools={};' +
  CONTEXT_SITE +
  'return $counted;}';
const RENDER_SITE =
  'let $options={},$active=false,$result=$config?.withoutAttachmentHooks?$live($row,$options):$recorded($row,$options,$active),$rendered=$result.messages,{isKnownType:$known,recordedRole:$role}=$result;';
const RENDER =
  ';function $render($rows,$visible=[],$model,$config){$rows=$fold($rows,$config?.accountMemoryWithheld,$memo(()=>$visible));let $output=[];for(let $row of $rows){' +
  RENDER_SITE +
  '$output.push(...$rendered)}return $output;}';
const PRISTINE = API + CONTEXT + RENDER;
const TOOLS = [{ name: 'Bash' }, { name: 'Glob' }, { name: 'Grep' }];

type Message = {
  type?: string;
  isMeta?: boolean;
  message: { role?: string; content: string | unknown[] };
};

type Fixture = {
  $query: (input: {
    systemPrompt: string[];
    userContext: object;
    systemContext: string[];
    canUseTool: undefined;
    toolUseContext: { options: { tools: { name: string }[] } };
    snapshot?: { systemPrompt: string[] };
  }) => AsyncGenerator<{ systemPrompt: string[] }>;
  $context: (
    messages: unknown[],
    model: string,
    permissions: object,
    tools: { name: string }[],
    agents: unknown[],
    details: { prompt: string[]; snapshot?: { systemPrompt: string[] } }
  ) => Promise<string[]>;
  $render: (
    rows: { attachment: { type: string }; messages: Message[] }[],
    tools: { name: string }[],
    model: undefined,
    options?: { withoutAttachmentHooks: boolean }
  ) => Message[];
};

const evaluate = (source: string): Fixture =>
  new Function(
    '$identity',
    '$merge',
    '$extra',
    '$fold',
    '$memo',
    '$live',
    '$recorded',
    source + ';return{$query,$context,$render};'
  )(
    (value: unknown) => value,
    (prompt: string[], environment: string[]) => [...prompt, ...environment],
    () => undefined,
    (rows: unknown) => rows,
    (callback: () => unknown) => callback(),
    (row: { messages: Message[] }) => ({ messages: row.messages }),
    (row: { messages: Message[] }) => ({
      messages: row.messages,
      isKnownType: true,
      recordedRole: 'system',
    })
  ) as Fixture;

const query = async (
  fixture: Fixture,
  prompt: string[],
  tools = TOOLS,
  snapshot?: { systemPrompt: string[] }
): Promise<string[]> => {
  const result = await fixture
    .$query({
      systemPrompt: prompt,
      userContext: {},
      systemContext: ['environment'],
      canUseTool: undefined,
      toolUseContext: { options: { tools } },
      snapshot,
    })
    .next();
  return result.value.systemPrompt;
};

describe('fff instruction runtime', () => {
  it('appends once after a custom prompt without mutating its array', () => {
    const original = ['My custom instructions.'];
    const first = normalizeFffPrompt(original, TOOLS, FFF_PROJECT_GUIDANCE);
    expect(first).toEqual([...original, FFF_PROJECT_GUIDANCE]);
    expect(normalizeFffPrompt(first, TOOLS, FFF_PROJECT_GUIDANCE)).toBe(first);
    expect(original).toEqual(['My custom instructions.']);
    expect(
      normalizeFffPrompt(original, [{ name: 'Read' }], FFF_PROJECT_GUIDANCE)
    ).toBe(original);
  });

  it.each([undefined, null, {}, 'custom string', ['valid', 3]])(
    'leaves unsupported prompt inputs unchanged: %s',
    prompt => {
      expect(normalizeFffPrompt(prompt, TOOLS, FFF_PROJECT_GUIDANCE)).toBe(
        prompt
      );
    }
  );

  it.each(['strict', 'relaxed'])(
    'changes only the %s search clause',
    variant => {
      const prefix =
        variant === 'strict'
          ? 'Do your work through Bash wherever it can accomplish the job: '
          : 'You can do much of your work through Bash when it is simpler: ';
      const text =
        prefix +
        'read files with cat, search with grep and find, and make changes with sed. Permissions and edit rules stay here.';
      const original = [
        { isMeta: true, message: { role: 'user', content: text } },
      ];
      const result = normalizeFffAutoMode(
        original,
        { type: 'auto_mode' },
        TOOLS,
        FFF_PROJECT_GUIDANCE
      ) as Message[];
      const updated = result[0].message.content as string;
      const replacement =
        'start discovery of unknown project files with fff files in Bash, use Glob for exact filename patterns, and use Grep for file contents';
      expect(updated.replace(replacement, 'search with grep and find')).toBe(
        text
      );
      expect(result[0].isMeta).toBe(true);
      expect(original[0].message.content).toBe(text);
      expect(
        normalizeFffAutoMode(
          result,
          { type: 'auto_mode' },
          TOOLS,
          FFF_PROJECT_GUIDANCE
        )
      ).toBe(result);
    }
  );

  it('preserves mixed content and only names available native tools', () => {
    const image = { type: 'image', source: { synthetic: true } };
    const untouched = {
      type: 'text',
      text: 'Permission and edit instructions.',
    };
    const original = [
      {
        message: {
          content: [
            untouched,
            { type: 'text', text: 'search with grep and find' },
            image,
          ],
        },
      },
    ];
    const result = normalizeFffAutoMode(
      original,
      { type: 'auto_mode' },
      [{ name: 'Bash' }],
      FFF_PROJECT_GUIDANCE
    ) as Message[];
    const content = result[0].message.content as { text?: string }[];
    expect(content[0]).toBe(untouched);
    expect(content[2]).toBe(image);
    expect(content[1].text).toContain('fff files');
    expect(content[1].text).not.toContain('Glob');
    expect(content[1].text).not.toContain('Grep');
    expect(
      normalizeFffAutoMode(
        original,
        { type: 'plan_mode' },
        TOOLS,
        FFF_PROJECT_GUIDANCE
      )
    ).toBe(original);
    expect(
      normalizeFffAutoMode(
        original,
        { type: 'auto_mode' },
        [{ name: 'Grep' }],
        FFF_PROJECT_GUIDANCE
      )
    ).toBe(original);
  });
});

describe('fff scoped instruction patch', () => {
  it('normalizes current and saved prompts after native snapshot selection', async () => {
    const patched = writeFffInstructions(PRISTINE)!;
    expect(patched).not.toBeNull();
    const fixture = evaluate(patched);
    for (const prompt of [['default'], ['custom override', 'user appendix']]) {
      expect(await query(fixture, prompt)).toEqual([
        ...prompt,
        'environment',
        FFF_PROJECT_GUIDANCE,
      ]);
    }
    const snapshot = { systemPrompt: ['old saved prompt'] };
    expect(await query(fixture, ['new live prompt'], TOOLS, snapshot)).toEqual([
      'old saved prompt',
      'environment',
      FFF_PROJECT_GUIDANCE,
    ]);
    expect(snapshot.systemPrompt).toEqual(['old saved prompt']);
    expect(
      await fixture.$context([], 'model', {}, TOOLS, [], {
        prompt: ['live'],
        snapshot,
      })
    ).toEqual(['old saved prompt', FFF_PROJECT_GUIDANCE]);
    expect(
      await query(fixture, ['custom'], [{ name: 'Read' }], snapshot)
    ).toEqual(['old saved prompt', 'environment']);
    expect(
      await fixture.$context([], 'model', {}, [{ name: 'Read' }], [], {
        prompt: ['live'],
        snapshot,
      })
    ).toBe(snapshot.systemPrompt);
    expect(writeFffInstructions(patched)).toBe(patched);
  });

  it.each(['auto', 'bypass'])(
    'corrects current and recorded %s attachment messages',
    mode => {
      const fixture = evaluate(writeFffInstructions(PRISTINE)!);
      for (const variant of ['strict', 'relaxed']) {
        const text = `${mode}/${variant}: search with grep and find; permission text; edit text.`;
        const messages = [{ type: 'user', message: { content: text } }];
        for (const withoutAttachmentHooks of [false, true]) {
          const rows = [{ attachment: { type: 'auto_mode' }, messages }];
          const rendered = fixture.$render(rows, TOOLS, undefined, {
            withoutAttachmentHooks,
          });
          expect(rendered[0].message.content).toContain('fff files');
          expect(rendered[0].message.content).toContain(
            'permission text; edit text.'
          );
          expect(messages[0].message.content).toBe(text);
          expect(fixture.$render(rows, [{ name: 'Read' }], undefined)[0]).toBe(
            messages[0]
          );
        }
      }
    }
  );

  it('leaves restoration and disabled feature behavior in pristine source', async () => {
    const saved = { systemPrompt: ['saved'] };
    const patched = evaluate(writeFffInstructions(PRISTINE)!);
    expect(await query(patched, ['base'], TOOLS, saved)).toContain(
      FFF_PROJECT_GUIDANCE
    );
    const restored = evaluate(PRISTINE);
    expect(await query(restored, ['base'], TOOLS, saved)).toEqual([
      'saved',
      'environment',
    ]);
    expect(saved).toEqual({ systemPrompt: ['saved'] });
    expect(PRISTINE).not.toContain('__tweakccFff');
  });

  it('serializes explicit guidance without closures or template interpolation', async () => {
    const guidance = 'Synthetic `code` ${placeholder} \\ "quoted" é text.';
    const patched = writeFffInstructions(PRISTINE, guidance)!;
    expect(patched).not.toContain('é');
    expect(await query(evaluate(patched), ['custom'])).toEqual([
      'custom',
      'environment',
      guidance,
    ]);
    expect(writeFffInstructions(patched, guidance)).toBe(patched);
  });

  it('bounds parser scopes across braces in strings, regexes, and templates', () => {
    const source = PRISTINE.replace(
      API_SITE,
      'let $braces="}",$regex=/[{}]/,$template=`${"}"}`;' + API_SITE
    );
    expect(writeFffInstructions(source)).not.toBeNull();
  });

  it.each([
    ['missing API scope', PRISTINE.replace(API, '')],
    ['missing context scope', PRISTINE.replace(CONTEXT, '')],
    ['missing renderer scope', PRISTINE.replace(RENDER, '')],
    ['ambiguous API scope', PRISTINE + ';' + API],
    ['ambiguous context scope', PRISTINE + CONTEXT],
    ['ambiguous renderer scope', PRISTINE + RENDER],
    ['missing API initializer', PRISTINE.replace(API_SITE, '')],
    ['missing context initializer', PRISTINE.replace(CONTEXT_SITE, '')],
    ['missing renderer initializer', PRISTINE.replace(RENDER_SITE, '')],
    [
      'neighboring API initializer',
      PRISTINE.replace(API_SITE, '') +
        ';function $neighbor(){' +
        API_SITE +
        '}',
    ],
    [
      'neighboring context initializer',
      PRISTINE.replace(CONTEXT_SITE, '') +
        ';function $neighbor(){' +
        CONTEXT_SITE +
        '}',
    ],
    [
      'neighboring renderer initializer',
      PRISTINE.replace(RENDER_SITE, '') +
        ';function $neighbor(){' +
        RENDER_SITE +
        '}',
    ],
    [
      'nested API initializer',
      PRISTINE.replace(API_SITE, 'function $nested(){' + API_SITE + '}'),
    ],
    [
      'nested context initializer',
      PRISTINE.replace(
        CONTEXT_SITE,
        'function $nested(){' + CONTEXT_SITE + '}'
      ),
    ],
    [
      'nested renderer initializer',
      PRISTINE.replace(RENDER_SITE, 'function $nested(){' + RENDER_SITE + '}'),
    ],
    [
      'ambiguous API initializer',
      PRISTINE.replace(API_SITE, '{' + API_SITE + '}{' + API_SITE + '}'),
    ],
    [
      'ambiguous context initializer',
      PRISTINE.replace(
        CONTEXT_SITE,
        '{' + CONTEXT_SITE + '}{' + CONTEXT_SITE + '}'
      ),
    ],
    [
      'ambiguous renderer initializer',
      PRISTINE.replace(
        RENDER_SITE,
        '{' + RENDER_SITE + '}{' + RENDER_SITE + '}'
      ),
    ],
  ])('rejects %s without partial edits', (_name, source) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(writeFffInstructions(source)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        'patch: swapRipgrepForFff: failed to find unique scoped search instruction boundaries'
      );
    } finally {
      error.mockRestore();
    }
  });
});
