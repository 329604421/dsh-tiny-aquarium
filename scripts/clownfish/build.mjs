// 小丑鱼资产重建入口：找得到哪个 Python 就用哪个，避免文档里的命令在本机直接报
// "python 不是内部或外部命令"。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts', 'clownfish', 'build_clownfish.py');
const bundled = path.join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

const candidates = [
  process.env.PYTHON ? { cmd: process.env.PYTHON, args: [] } : null,
  { cmd: 'python', args: [] },
  { cmd: 'py', args: ['-3'] },
  existsSync(bundled) ? { cmd: bundled, args: [] } : null,
].filter(Boolean);

for (const candidate of candidates) {
  const probe = spawnSync(candidate.cmd, [...candidate.args, '-c', 'import numpy, PIL'], { stdio: 'ignore' });
  if (probe.status !== 0) continue;
  const run = spawnSync(candidate.cmd, [...candidate.args, script], { cwd: root, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
console.error('找不到带 numpy + Pillow 的 Python。设置 PYTHON 环境变量指向一个可用的解释器。');
process.exit(1);
