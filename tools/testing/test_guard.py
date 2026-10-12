#!/usr/bin/env python3
"""Fast, dependency-free test-scope guard. Parses commands; never executes them."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
MAX_FILES = 3
MAX_DEPTH = 12
class Block(Exception):
    pass

def tokens(command):
    # Expansions cannot be resolved without executing a shell. Preserve literal quotes.
    quote = None
    escaped = False
    comment = False
    rendered = []
    previous = ' '
    for ch in command.replace('\\\n', ''):
        if comment:
            if ch == '\n':
                rendered.append(';'); comment = False; previous = ' '
            continue
        if ch == '#' and quote is None and previous in ' \t\r\n;|&()':
            comment = True; continue
        rendered.append(';' if ch == '\n' and quote is None else ch)
        previous = ch
        if escaped:
            escaped = False
            continue
        if ch == '\\' and quote != "'":
            escaped = True
            continue
        if ch in "\"'":
            if quote is None: quote = ch
            elif quote == ch: quote = None
        elif ch in '$`' and quote != "'":
            raise Block('Dynamic shell expansion is unsupported; use literal commands/paths.')
    if quote: raise Block('Unclosed shell quote.')
    lex = shlex.shlex(''.join(rendered), posix=True, punctuation_chars=';&|()<>')
    lex.whitespace = ' \t\r'
    lex.commenters = ''
    lex.whitespace_split = True
    result=[]
    for value in lex:
        if value and set(value)<=set(';&|()<>'):
            result.extend(re.findall(r'&&|\|\||>>|<<|>&|<&|[;&|()<>]',value))
        else:result.append(value)
    return result

VALUE_OPTIONS = {
    '-k', '-m', '-t', '-p', '-n', '-c', '--tb', '--durations', '--durations-min',
    '--maxfail', '--rootdir', '--confcutdir', '--import-mode', '--log-level',
    '--log-cli-level', '--capture', '--color', '--junitxml', '--basetemp',
    '--deselect', '--ignore', '--ignore-glob', '--timeout', '--reporter',
    '--outputFile', '--testNamePattern', '--test-name-pattern', '--test-skip-pattern',
    '--project', '--workers', '--maxWorkers', '--minWorkers', '--grep', '--grep-invert',
    '--retries', '--trace', '--report-dir', '--output', '--reporter-option',
    '--name', '--plain-name', '--tags', '--exclude-tags', '--concurrency',
    '--test-concurrency', '--test-reporter', '--test-reporter-destination',
    '--disable-warning', '--environment', '--pool', '--mode', '--dir', '--config',
    '--testMatch', '--testPathPattern', '--testPathPatterns', '--testTimeout',
}
BOOL_OPTIONS = {
    '-q','-v','-vv','-vvv','-x','-s','-ra','-rx','--collect-only','--list',
    '--filesOnly','--json','--run','--coverage','--no-coverage','--no-pub',
    '--no-file-parallelism','--fileParallelism=false','--disable-warnings',
    '--strict-markers','--strict-config','--disable-plugin-autoload','--no-header',
    '--no-summary','--showlocals','--runInBand','--watch=false','--watchAll=false',
    '--headless','--headed','--debug','--fail-fast','--bail','--no-color','--test',
}
RUNNERS = {'pytest','py.test','vitest','jest','playwright','mocha','ava','nosetests'}
SHELLS = {'bash','sh','zsh','dash','fish'}
INTERPRETERS = {'python','python3','python3.13','node','bun','tsx','ts-node','ruby','perl'}
BROAD_TOOLS = {'tox','nox','make','gmake','just','task'}

class Guard:
    def __init__(self):
        self.stack = set()
        self.targets = set()
        self.runner_calls = 0
        p = HERE/'reviewed_scripts.json'
        self.reviewed = json.loads(p.read_text()) if p.exists() else {}

    def check(self, command, cwd, depth=0):
        if depth > MAX_DEPTH or len(command) > 65536: raise Block('Command too complex to resolve safely.')
        ts = tokens(command)
        part = []
        groups=[]
        for t in ts + [';']:
            if t in [';', '&&', '||', '|', '&', '\n', '(', ')']:
                if part: cwd = self.argv(part, cwd, depth+1); part = []
                if t=='(':groups.append(cwd)
                elif t==')':
                    if not groups:raise Block('Unbalanced shell group.')
                    cwd=groups.pop()
            elif all(c in ';&|()' for c in t):
                raise Block('Unsupported shell control syntax.')
            else: part.append(t)
        if groups:raise Block('Unbalanced shell group.')
        return cwd

    def argv(self, args, cwd, depth):
        if depth > MAX_DEPTH: raise Block('Wrapper recursion limit.')
        args = list(args)
        # Output redirection is harmless to selection; stdin/heredocs are opaque wrappers.
        clean=[];i=0
        while i < len(args):
            if args[i] in ['>', '>>', '>&']:
                if clean and clean[-1].isdigit():clean.pop()
                i += 2;continue
            if '<' in args[i] and set(args[i]) <= set('<>'):
                raise Block('Input redirection/heredocs are opaque execution paths.')
            clean.append(args[i]);i+=1
        args=clean
        while args and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=',args[0]):
            name=args.pop(0).split('=',1)[0]
            if name in {'PYTEST_ADDOPTS','NODE_OPTIONS','BASH_ENV','ENV','SHELLOPTS','PATH','PYTHONPATH','PYTHONSTARTUP'}:
                raise Block('Execution-affecting environment overrides require review.')
        if not args:return cwd
        exe=Path(args[0]).name;a=args[1:]
        if exe in ['export','alias','eval','source','.','xargs','parallel']:
            raise Block('Dynamic shell/wrapper execution is unsupported; use the direct scoped command.')
        if exe in ['if','then','else','elif','fi','for','while','do','done','function','{','}']:
            raise Block('Shell control flow/functions are unsupported; use direct commands.')
        if exe in ['rg','grep'] and any(x=='--pre' or x.startswith('--pre=') for x in a):
            raise Block('Search preprocessor execution is an opaque wrapper.')
        if exe=='find' and any(x in a for x in ['-exec','-execdir','-ok','-okdir']):
            raise Block('find execution wrappers require a direct scoped command.')
        if exe=='git':
            if a[:1]==['config'] and any(x in a for x in ['--get','--get-all','--get-regexp','--list','-l']):return cwd
            if '-c' in a or '--config-env' in a or any(x.startswith('--config-env=') for x in a):
                raise Block('Git command/config aliases can execute opaque wrappers.')
            rest=list(a)
            while rest and rest[0] in ['-C','--git-dir','--work-tree']:
                rest=rest[2:]
            safe={'status','diff','log','show','ls-files','rev-parse','branch','fetch','pull','push','add','commit','restore','checkout','switch','worktree','merge','rebase','cherry-pick','remote','tag','check-ignore','stash','reset','init','clean','reflog','describe','help','version','--version'}
            if rest and rest[0] not in safe:raise Block('Unknown Git subcommand/configuration may be an executable alias.')
            return cwd
        if exe=='cd':
            if len(a)!=1 or a[0].startswith('-'):raise Block('Use cd with one literal directory.')
            p=(cwd/a[0]).resolve()
            if not p.is_dir():raise Block('Cannot resolve working directory.')
            return p
        if exe in ['command','exec','nohup','time']:
            if exe=='command' and a[:1] in [['-v'],['-V']]:return cwd
            while a and a[0].startswith('-'):
                opt=a.pop(0)
                if opt in ['-a','-f','--format','-o','--output'] and exe in ['exec','time']:
                    if not a:raise Block('Missing wrapper option argument.')
                    a.pop(0)
                elif opt not in ['--','-p','-c','-l','--verbose']:raise Block('Unsupported wrapper option.')
            return self.argv(a,cwd,depth+1)
        if exe in ['timeout','gtimeout']:
            while a and a[0].startswith('-'):
                opt=a.pop(0)
                if opt in ['-k','--kill-after','-s','--signal']:a=a[1:]
            if not a:raise Block('Malformed timeout wrapper.')
            return self.argv(a[1:],cwd,depth+1)
        if exe=='env':
            if a and a[0]=='-S':return self.check(' '.join(a[1:]),cwd,depth+1)
            while a and a[0].startswith('-'):
                opt=a.pop(0)
                if opt in ['-u','--unset']:a=a[1:]
                elif opt not in ['-i','--ignore-environment','--']:raise Block('Unsupported env option.')
            return self.argv(a,cwd,depth+1)
        if exe in ['sudo','nice']:
            while a and a[0].startswith('-'):
                opt=a.pop(0)
                if (exe=='nice' and opt in ['-n','--adjustment']) or (exe=='sudo' and opt in ['-u','-g','--user','--group']):
                    if not a:raise Block('Missing wrapper option argument.')
                    a.pop(0)
                elif opt not in ['--','-n','-E','-H','--non-interactive']:raise Block('Unsupported wrapper option.')
            return self.argv(a,cwd,depth+1)
        if exe in SHELLS:
            if a in [['--help'],['--version']]:return cwd
            flag=next((i for i,x in enumerate(a) if x.startswith('-') and 'c' in x),None)
            if flag is not None:
                if len(a)!=flag+2:raise Block('Shell positional forwarding is unsupported.')
                self.check(a[flag+1],cwd,depth+1)
                return cwd
            if not a:raise Block('Interactive/stdin shell execution is unsupported.')
            return self.script(a[0],a[1:],cwd,depth+1)
        if exe=='bun' and a[:1]==['test']:return self.tests('bun',a[1:],cwd)
        if exe=='bunx':return self.package('npx',a,cwd,depth+1)
        if exe in ['npm','pnpm','yarn','npx','bun']:
            return self.package(exe,a,cwd,depth+1)
        if exe in ['uv','poetry','pipenv'] and 'run' in a:
            rest=a[a.index('run')+1:]
            while rest and rest[0] in ['--no-sync','--offline','--no-project','--']:rest.pop(0)
            if rest and rest[0].startswith('-'):raise Block('Unsupported environment-runner option.')
            return self.argv(rest,cwd,depth+1)
        if exe in ['docker','podman','ssh','kubectl']:
            # Remote/container command execution cannot share local selection guarantees.
            if any(x in a for x in ['exec','run']) or exe=='ssh':raise Block('Remote/container execution requires separate approved verification.')
            return cwd
        if exe in BROAD_TOOLS:
            raise Block('Task-runner wrappers require a direct scoped command or explicit authorization.')
        if exe in RUNNERS:
            if exe=='playwright' and a[:1]!=['test']:return cwd
            return self.tests(exe,a[1:] if a[:1] in [['run'],['test'],['list']] else a,cwd)
        if exe in ['flutter','dart'] and 'test' in a:return self.tests(exe,a[a.index('test')+1:],cwd)
        if exe.startswith('python'):
            if a[:1]==['-m']:
                if len(a)<2:raise Block('Missing Python module.')
                if a[1] in ['pytest','unittest','nose']:return self.tests(a[1],a[2:],cwd)
                if a[1] not in ['uvicorn','alembic','ruff','compileall','py_compile','json.tool']:
                    raise Block('Unreviewed Python module wrapper.')
                return cwd
            if a in [['--version'],['--help'],['-V'],['-h']]:return cwd
            if a[:1]==['-c'] and len(a)==2:
                self.python_inline(a[1]);return cwd
            if not a or a[0].startswith('-'):raise Block('Inline/stdin Python cannot be statically scoped.')
            return self.script(a[0],a[1:],cwd,depth+1)
        if exe=='node':
            if '--test' in a or any(x.startswith('--test=') for x in a):return self.tests('node',a,cwd)
            if a in [['--version'],['--help'],['-v']]:return cwd
            if not a or a[0].startswith('-'):raise Block('Inline/stdin Node cannot be statically scoped.')
            p=a[0]
            if Path(p).name in ['vitest.mjs','cli.js'] and ('vitest' in p or 'playwright' in p or 'jest' in p):
                runner='vitest' if 'vitest' in p else 'playwright' if 'playwright' in p else 'jest'
                return self.argv([runner]+a[1:],cwd,depth+1)
            return self.script(p,a[1:],cwd,depth+1)
        p=(cwd/args[0]).resolve()
        if p.is_file() and (p.suffix in ['.sh','.py','.js','.mjs','.cjs','.ts'] or '/' in args[0]):
            return self.script(args[0],a,cwd,depth+1)
        return cwd

    def script(self, name, forwarded, cwd, depth):
        p=(cwd/name).resolve()
        if not p.is_file():raise Block('Cannot inspect executable wrapper: '+name)
        data=p.read_bytes()
        if len(data)>65536:raise Block('Executable wrapper is too large to inspect.')
        rel=os.path.relpath(p,HERE.parent.parent)
        if self.reviewed.get(rel)==hashlib.sha256(data).hexdigest():
            if rel.startswith('.specify/'):
                for dep,h in self.reviewed.items():
                    if dep.startswith('.specify/'):
                        f=HERE.parent.parent/dep
                        if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest()!=h:
                            raise Block('Reviewed Spec Kit script dependency changed; re-review the wrapper.')
            return cwd
        if p.suffix=='.sh' or data.startswith(b'#!/bin/bash') or data.startswith(b'#!/usr/bin/env bash'):
            text=data.decode().replace('"$@"',shlex.join(forwarded)).replace('$@',shlex.join(forwarded))
            key=str(p)
            if key in self.stack:raise Block('Recursive executable wrapper.')
            self.stack.add(key)
            try:
                self.check(text,cwd,depth+1)
                return cwd
            finally:self.stack.remove(key)
        raise Block('Opaque executable wrapper; use a direct scoped runner or explicitly authorize it.')

    def python_inline(self, text):
        try: tree=ast.parse(text)
        except SyntaxError: raise Block('Invalid inline Python.')
        modules={'json','pathlib','hashlib','re'}
        builtins={'print','len','str','int','float','bool','list','dict','set','tuple','sorted','enumerate','range','sum','min','max','any','all','zip','Path'}
        methods={'read_text','read_bytes','exists','is_file','is_dir','resolve','glob','rglob','iterdir','stat','relative_to','as_posix','dumps','loads','compile','search','match','findall','sub','split','join','strip','replace','startswith','endswith','encode','decode','sha256','hexdigest'}
        for n in ast.walk(tree):
            if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef,ast.Lambda,ast.With,ast.AsyncWith)):
                raise Block('Opaque inline Python definitions/context execution.')
            if isinstance(n,ast.Import) and any(x.name not in modules for x in n.names):raise Block('Unreviewed inline Python import.')
            if isinstance(n,ast.ImportFrom) and (n.module not in modules or n.level):raise Block('Unreviewed inline Python import.')
            if isinstance(n,ast.Attribute) and n.attr.startswith('__'):raise Block('Dynamic inline Python attribute.')
            if isinstance(n,ast.Call):
                f=n.func
                if isinstance(f,ast.Name) and f.id in builtins:continue
                if isinstance(f,ast.Attribute) and f.attr in methods:continue
                raise Block('Unreviewed inline Python call; use a scoped runner or reviewed script.')

    def package(self, manager, args, cwd, depth):
        original_cwd=cwd
        args=list(args)
        while args and args[0].startswith('-'):
            opt=args.pop(0)
            if opt in ['--prefix','-C','--dir','--cwd']:
                if not args:raise Block('Missing package directory.')
                cwd=(cwd/args.pop(0)).resolve()
            elif opt in ['--filter','-F']:
                if not args:raise Block('Missing package filter.')
                name=args.pop(0)
                if any(x in name for x in '*![]{},'):raise Block('Broad package filter.')
                matches=[]
                for p in (cwd/'packages').glob('*/package.json'):
                    if json.loads(p.read_text()).get('name')==name:matches.append(p.parent)
                for p in (cwd/'packages').glob('*/*/package.json'):
                    if json.loads(p.read_text()).get('name')==name:matches.append(p.parent)
                if len(matches)!=1:raise Block('Package filter must resolve one local package.')
                cwd=matches[0]
            elif opt not in ['--no-install','--yes','-y','--silent','-s','--offline']:
                raise Block('Unsupported package-manager option.')
        if not args:return cwd
        if manager=='npx' or args[0] in ['exec','x']:
            if args[0] in ['exec','x']:args.pop(0)
            if args[:1]==['--']:args.pop(0)
            if args and args[0].startswith('-'):raise Block('Opaque package exec shell/options.')
            self.argv(args,cwd,depth+1)
            return original_cwd
        if args[0] in ['install','ci','add','update','rebuild']:
            raise Block('Dependency lifecycle scripts can invoke tests; installation requires explicit authorization.')
        if args[0] in ['--version','--help','-v','help','list','ls','audit','outdated']:return cwd
        if args[0] in ['run','run-script']:args.pop(0)
        if not args:raise Block('Missing package script.')
        name=args.pop(0)
        if args[:1]==['--']:args.pop(0)
        p=cwd/'package.json'
        if not p.exists():raise Block('Cannot resolve package script in working directory.')
        scripts=json.loads(p.read_text()).get('scripts',{})
        if name not in scripts:raise Block('Unknown package script: '+name)
        key=str(p)+':'+name
        if key in self.stack:raise Block('Recursive package script.')
        self.stack.add(key)
        try:
            for step in ['pre'+name,name,'post'+name]:
                if step in scripts:
                    script=scripts[step]
                    if step==name and args:
                        # npm appends arguments to the final simple command, not each pipeline stage.
                        script+=' '+shlex.join(args)
                    self.check(script,cwd,depth+1)
        finally:self.stack.remove(key)
        return original_cwd

    def tests(self, runner, args, cwd):
        if args in [['--help'],['-h'],['--version']]:return cwd
        if os.environ.get('PYTEST_ADDOPTS') or os.environ.get('NODE_OPTIONS'):
            raise Block('Inherited runner injection options require review.')
        self.runner_calls += 1
        if self.runner_calls > 3:raise Block('Split verification into a meaningful slice, not many chained test runs.')
        targets=[];i=0
        while i<len(args):
            x=args[i];i+=1
            if x=='--':targets.extend(args[i:]);break
            if x.startswith('-'):
                key=x.split('=',1)[0]
                if key in VALUE_OPTIONS:
                    if '=' not in x:
                        if i>=len(args):raise Block('Missing runner option value.')
                        i+=1
                elif x not in BOOL_OPTIONS:raise Block('Unreviewed runner option: '+x)
                continue
            targets.append(x)
        if not targets or len(targets)>MAX_FILES:
            raise Block('Select 1–3 explicit affected test files/nodes; no default or broad suite.')
        for target in targets:
            f=target.split('::',1)[0]
            if runner=='playwright':f=re.sub(r':\d+(?::\d+)?$','',f)
            if any(x in f for x in '*?[]{}') or not (cwd/f).is_file():
                raise Block('Test target must be an existing explicit file, not a directory/glob/filter: '+target)
            self.targets.add(str((cwd/f).resolve()))
            if len(self.targets)>MAX_FILES:raise Block('Compound commands may select at most three unique test files.')
            if not f.endswith(('.py','.ts','.tsx','.js','.jsx','.mjs','.cjs','.dart')):
                raise Block('Unsupported test file: '+target)
        return cwd

# Authorization comes only from a literal, direct user message, never an environment flag.
# This is an editable development safeguard, not a sandbox against a malicious agent/user.
def approval_path(session):
    if not session:return None
    d=Path(tempfile.gettempdir())/('kafuo-test-approvals-'+str(os.getuid()))
    d.mkdir(mode=0o700,exist_ok=True)
    if d.is_symlink() or d.stat().st_uid!=os.getuid():raise ValueError('Unsafe authorization directory.')
    d.chmod(0o700)
    return d/(hashlib.sha256(session.encode()).hexdigest()+'.json')

def authorize(payload):
    prompt=payload.get('prompt','')
    prefix='APPROVE_FULL_TEST '
    if not prompt.startswith(prefix):return
    grant=json.loads(prompt[len(prefix):])
    if set(grant)!={'cwd','command','reason'} or not all(isinstance(v,str) and v.strip() for v in grant.values()):
        raise ValueError('Approval requires exactly cwd, command and reason.')
    cwd=Path(grant['cwd'])
    if not cwd.is_absolute() or not cwd.is_dir():raise ValueError('Approval cwd must be an existing absolute directory.')
    p=approval_path(payload.get('session_id'))
    if p is None:raise ValueError('Approval requires session identity.')
    grant.update(cwd=str(cwd.resolve()),expires=time.time()+900)
    if p.is_symlink():raise ValueError('Refusing authorization symlink.')
    fd,name=tempfile.mkstemp(dir=p.parent,prefix='.grant-')
    with os.fdopen(fd,'w') as f:json.dump(grant,f)
    os.replace(name,p)

def approved(payload):
    p=approval_path(payload.get('session_id'))
    if p is None or not p.exists():return False
    if p.is_symlink():raise ValueError('Refusing authorization symlink.')
    j=json.loads(p.read_text())
    match=j.get('expires',0)>time.time() and j.get('command')==payload['command'] and j.get('cwd')==str(Path(payload['cwd']).resolve())
    if match:p.unlink() # one exact command, once, within 15 minutes
    return match

def evaluate(payload):
    try:
        command=payload['command'];cwd=Path(payload['cwd']).resolve()
        if not isinstance(command,str) or not cwd.is_dir():raise Block('Invalid command/cwd.')
        Guard().check(command,cwd)
        return {'allowed':True,'reason':'Focused/static command; existing permissions still apply.'}
    except Block as e:
        if approved(payload):return {'allowed':True,'authorized':True,'reason':'Exact one-use user authorization.'}
        return {'allowed':False,'reason':str(e)+' Map impact and use scoped files. Broad/opaque execution requires explicit APPROVE_FULL_TEST authorization; never expand scope after an unrelated failure.'}

def main():
    mode=sys.argv[1] if len(sys.argv)>1 else '--claude'
    p=json.load(sys.stdin)
    if mode.startswith('--authorize'):
        authorize(p);return
    if mode=='--claude':
        if p.get('tool_name')!='Bash':return
        p={'command':p.get('tool_input',{}).get('command'),'cwd':p.get('cwd'), 'session_id':p.get('session_id')}
    result=evaluate(p)
    if mode=='--claude':
        if not result['allowed']:print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':result['reason']}}))
    else:print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('Kafuo test guard failed closed: '+str(e),file=sys.stderr);sys.exit(2)
