// Runs the TypeScript checker if one is installed on the machine.
// The checker is an optional developer tool, never a project dependency:
// the code builds and runs without it.
import { spawnSync } from 'node:child_process';

const probe = spawnSync('tsc', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (probe.status !== 0) {
  console.log('tsc не найден: проверка типов пропущена. Установите TypeScript глобально, чтобы включить её.');
  process.exit(0);
}
console.log(`Проверка типов (${probe.stdout.trim()})…`);
const result = spawnSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
