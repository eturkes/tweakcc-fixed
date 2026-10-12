import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def searches(command, cwd):
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars='|;&<>\n')
        lexer.whitespace_split = True
        lexer.whitespace = ' \t\r'
        lexer.commenters = '#'
        tokens = list(lexer)
    except ValueError:
        return []
    records = []
    segment = []
    piped = False
    redirected = False
    for token in tokens + [';']:
        if token in [';', '&&', '||', '|', '&'] or token.isspace():
            if segment and not piped:
                if segment[0] == 'cd' and len(segment) == 2:
                    target = Path(segment[1]).expanduser()
                    cwd = str((Path(cwd) / target).resolve())
                elif segment[0] in ['rg', 'grep'] and not any(
                    '$' in a or '`' in a or '\n' in a or a.startswith(('--pre', '--hostname-bin', '--filter', '--fff-', '--record-access', '--daemon', '--config', '-@')) for a in segment[1:]
                ):
                    records.append({'tool': segment[0], 'argv': segment[1:], 'cwd': cwd})
            segment = []
            piped = token == '|'
            redirected = False
        elif token in ['>', '>>', '<', '<<', '>&']:
            redirected = True
        elif not redirected:
            segment.append(token)
    return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, default=Path.home() / '.claude/projects')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--sessions', type=int, default=400)
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    repo = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()).resolve()
    if output == repo or repo in output.parents:
        parser.error('Private replay data must be stored outside the repository')
    records = []
    files = sorted(args.input.glob('*/*.jsonl'), key=lambda p: p.stat().st_mtime)[-args.sessions:]
    for file in files:
        try:
            lines = file.read_text(errors='replace').splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            cwd = event.get('cwd')
            if not isinstance(cwd, str):
                continue
            for block in (event.get('message') or {}).get('content') or []:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Bash':
                    command = (block.get('input') or {}).get('command')
                    if isinstance(command, str):
                        records.extend(searches(command, cwd))
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(records, file)
    print(json.dumps({'sessions': len(files), 'searches': len(records)}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'private_export_failed'}))
        sys.exit(1)
