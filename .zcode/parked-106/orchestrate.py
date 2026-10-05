# -*- coding: utf-8 -*-
# Фазы: P1 (Playwright запуск, окно, kill /T) → P2 (голый electron, тот же dir,
# stdout в файл) → анализируем, где висит P2 и появляется ли окно.
import os, subprocess, tempfile, shutil, time, glob, io

ROOT = r'D:\repositories\health-log\apps\desktop'
ELECTRON = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
ENTRY = 'dist/main/app/bootstrap.js'

d = tempfile.mkdtemp(prefix='hl-py-')
env = dict(os.environ)
env['HL_TEST_USER_DATA'] = d
env['HL_TEST_HOOKS'] = '1'

print('dir:', d, flush=True)
# P1 через playwright-зонд (переиспользуем probe-restart c argv dir)
p1 = subprocess.run(['node', 'probe-restart.mjs', d], cwd=ROOT,
                    capture_output=True, text=True, timeout=150, errors='replace')
p1tail = [l for l in (p1.stdout + p1.stderr).splitlines() if 'phase' in l or 'killed' in l]
print('P1:', '\n'.join(p1tail[:6]), flush=True)

time.sleep(2)
# P2 голым electron
log = open(os.path.join(d, 'p2-stdout.log'), 'w', encoding='utf-8', errors='replace')
p2 = subprocess.Popen([ELECTRON, ENTRY], cwd=ROOT, env=env,
                      stdout=log, stderr=subprocess.STDOUT)
time.sleep(25)
alive = p2.poll() is None
print('P2 alive after 25s:', alive, flush=True)
log.flush()
# Что в stdout P2?
s = io.open(os.path.join(d, 'p2-stdout.log'), encoding='utf-8', errors='replace').read()
print('P2 log tail:', s[-800:], flush=True)
# Окно P2? tasklist /V по electron
tl = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq electron.exe', '/V'],
                    capture_output=True, text=True, errors='replace').stdout
print('PROCS:', '\n'.join(l for l in tl.splitlines() if 'electron' in l.lower())[:800], flush=True)
subprocess.run(['taskkill', '/F', '/T', '/PID', str(p2.pid)], capture_output=True)
