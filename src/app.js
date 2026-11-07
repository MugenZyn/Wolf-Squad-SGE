import 'dotenv/config';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
console.log(`[runtime] Node.js ${process.version}`);
console.log(`[runtime] Platform ${process.platform} ${process.arch}`);
console.log('[git-sync] Checking GitHub for updates on origin/newmain...');

const pullCode = await new Promise(resolve => {
  const pull = spawn('git', ['pull', '--quiet', '--ff-only', 'origin', 'newmain'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let pullError = '';
  pull.stderr.setEncoding('utf8');
  pull.stderr.on('data', chunk => {
    pullError += chunk;
  });

  pull.on('error', error => {
    console.error('[git-sync] Could not run git pull; starting the currently installed files:', error.message);
    resolve(null);
  });
  pull.on('close', code => {
    if (code !== 0 && pullError.trim()) {
      console.error('[git-sync] Git pull error:', pullError.trim());
    }
    resolve(code);
  });
});

if (pullCode !== 0) {
  console.error(`[git-sync] Pull failed (exit ${pullCode}); starting the currently installed files.`);
}

try {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  console.log(`[git-sync] Running commit ${commit}`);
} catch (error) {
  console.error('[git-sync] Could not determine deployed Git commit:', error.message);
}

console.log('[git-sync] Starting bot application...');
await import('./bot.js');
