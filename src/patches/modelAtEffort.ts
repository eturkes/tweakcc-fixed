// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * Lets `/model opus@high` set the model and the effort in one go.
 *
 * The suffix is stripped before the normal `/model` flow runs, and a
 * successful switch chains `/effort <level>` through onDone's `nextInput`
 * (the same trick CC uses to chain `/reload-plugins`). Two things to keep:
 *
 * - Effort runs after the switch, not before: `/effort` applies to whatever
 *   model is current, so running it first would set the old model's effort.
 * - Only effort words split, never digits: Vertex model IDs look like
 *   `claude-opus-4-1@20250805` and have to reach `/model` intact.
 *
 * Success is "onDone called with no options". Failures and cancels pass
 * `{display:"system"}`, and the Fable consent path passes its own
 * `nextInput:"/upgrade"`, so anything with options goes through untouched.
 *
 * CC 2.1.285:
 * ```diff
 * -var xt=async(b,o,a)=>{if(a=a?.trim()||"",k2o(a))return i("tengu_model_command_inline_help",
 * +var xt=async(b,o,a)=>{let tweakccModelEffort=/^(.+)@(low|med|medium|high|xhigh|max|auto)$/i.exec(a?.trim()||"");if(tweakccModelEffort){...}if(a=a?.trim()||"",k2o(a))return i("tengu_model_command_inline_help",
 * ```
 */
export const writeModelAtEffort = (file: string): string | null => {
  const pattern =
    /=async\(([$\w]+),[$\w]+,([$\w]+)\)=>\{if\(\2=\2\?\.trim\(\)\|\|"",[$\w.]+\(\2\)\)return [$\w]+\("tengu_model_command_inline_help"/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: modelAtEffort: failed to find the /model command handler'
    );
    return null;
  }

  const [, onDone, args] = match;
  const insertIndex = match.index + match[0].indexOf('{') + 1;
  const insertion =
    `let tweakccModelEffort=/^(.+)@(low|med|medium|high|xhigh|max|auto)$/i.exec(${args}?.trim()||"");` +
    `if(tweakccModelEffort){${args}=tweakccModelEffort[1];let tweakccOnDone=${onDone};` +
    `${onDone}=(m,p)=>tweakccOnDone(m,p??{nextInput:"/effort "+tweakccModelEffort[2].toLowerCase(),submitNextInput:!0})}`;

  const newFile =
    file.slice(0, insertIndex) + insertion + file.slice(insertIndex);

  showDiff(file, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};
