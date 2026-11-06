import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
console.log('[git-sync] Checking GitHub for updates on origin/newmain...');

const pullCode = await new Promise(resolve => {
  const pull = spawn('git', ['pull', '--ff-only', 'origin', 'newmain'], {
    cwd: root,
    stdio: 'inherit',
  });
  pull.on('error', error => {
    console.error('[git-sync] Could not run git pull; starting the currently installed files:', error.message);
    resolve(null);
  });
  pull.on('close', code => resolve(code));
});

if (pullCode !== 0) {
  console.error(`[git-sync] Pull failed (exit ${pullCode}); starting the currently installed files.`);
}

console.log('[git-sync] Starting bot application...');
await import('./bot.js');
