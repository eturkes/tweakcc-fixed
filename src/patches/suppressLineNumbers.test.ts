import { describe, it, expect } from 'vitest';
import { writeSuppressLineNumbers } from './suppressLineNumbers';

// CC 2.1.131..2.1.157 — indexOf/while loop, helper returns tab-prefixed lines only.
const newShape =
  'function $E$({content:H,startLine:$}){if(!H)return"";' +
  'let q=[],K=$,_=0,A=H.indexOf(`\\n`);' +
  'while(A!==-1)q.push(y7q(H.slice(_,A),K++)),_=A+1,A=H.indexOf(`\\n`,_);' +
  'return q.push(y7q(H.slice(_),K)),q.join(`\\n`)}' +
  'function y7q(H,$){let q=H.endsWith("\\r")?H.slice(0,-1):H;' +
  'return`${$}\\t${q}`}';

// CC 2.1.158+ — third destructured param `tabAwareSeparator:q=!1`, separator
// chosen per-call, helper takes the separator as a third arg.
const tabAwareShape =
  'function fF$({content:H,startLine:$,tabAwareSeparator:q=!1}){if(!H)return"";' +
  'let K=q&&(H.startsWith("\\t")||H.includes(`\\n\\t`))?":":"\\t",_=[],z=$,A=0,Y=H.indexOf(`\\n`);' +
  'while(Y!==-1)_.push(evq(H.slice(A,Y),z++,K)),A=Y+1,Y=H.indexOf(`\\n`,A);' +
  'return _.push(evq(H.slice(A),z,K)),_.join(`\\n`)}' +
  'function evq(H,$,q){let K=H.endsWith("\\r")?H.slice(0,-1):H;' +
  'return`${$}${q}${K}`}';

// CC 2.1.86..2.1.107 — split() + feature-flag picks tab vs arrow.
const splitShape =
  'function uk$({content:q,startLine:K}){if(!q)return"";' +
  'let _=q.split(/\\r?\\n/);if(kf1())return _.map((Y,z)=>`${z+K}\\t${Y}`).join(`\\n`);' +
  'return _.map((Y,z)=>{let A=String(z+K);' +
  'if(A.length>=6)return`${A}\\u2192${Y}`;' +
  'return`${A.padStart(6," ")}\\u2192${Y}`}).join(`\\n`)}' +
  'function next1(){}';

// Pre-2.1.86 — inline split().map() with pure arrow + padStart.
const ancientShape =
  'function RD$({content:A,startLine:q}){if(!A)return"";' +
  'return A.split(/\\r?\\n/).map((Y,_)=>{let z=_+q,w=String(z);' +
  'if(w.length>=6)return`${w}\\u2192${Y}`;' +
  'return`${w.padStart(6," ")}\\u2192${Y}`}).join(`\\n`)}' +
  'function next2(){}';

describe('suppressLineNumbers', () => {
  describe('writeSuppressLineNumbers', () => {
    it('neutralizes the new indexOf/while shape (CC 2.1.131+)', () => {
      const result = writeSuppressLineNumbers(newShape);
      expect(result).not.toBeNull();
      expect(result).toContain(
        '{content:H,startLine:$}){if(!H)return"";return H}'
      );
      expect(result).not.toContain('q.push(y7q');
    });

    it('neutralizes the tabAwareSeparator shape (CC 2.1.158+)', () => {
      const result = writeSuppressLineNumbers(tabAwareShape);
      expect(result).not.toBeNull();
      expect(result).toContain(
        '{content:H,startLine:$,tabAwareSeparator:q=!1}){if(!H)return"";return H}'
      );
      expect(result).not.toContain('_.push(evq');
    });

    it('neutralizes the split() shape (CC 2.1.86..2.1.107)', () => {
      const result = writeSuppressLineNumbers(splitShape);
      expect(result).not.toBeNull();
      expect(result).toContain(
        '{content:q,startLine:K}){if(!q)return"";return q}'
      );
      expect(result).not.toContain('_.map');
    });

    it('neutralizes the ancient inline split().map() shape (pre-2.1.86)', () => {
      const result = writeSuppressLineNumbers(ancientShape);
      expect(result).not.toBeNull();
      expect(result).toContain(
        '{content:A,startLine:q}){if(!A)return"";return A}'
      );
      expect(result).not.toContain('padStart');
    });

    it('preserves code outside the formatter', () => {
      const wrapped = `var leadingCode={x:1};${newShape}var trailingCode={y:2};`;
      const result = writeSuppressLineNumbers(wrapped)!;
      expect(result).toContain('var leadingCode={x:1};');
      expect(result).toContain('var trailingCode={y:2};');
    });

    it('returns null when no formatter pattern is present', () => {
      const result = writeSuppressLineNumbers(
        'function unrelated(){return 42}'
      );
      expect(result).toBeNull();
    });
  });
});
