import 'dotenv/config';
import { ensureBundledNodeRuntime } from './utils/bundledNodeRuntime.js';
import { spawn, execFileSync } from 'node:child_process';

const root = process.cwd();

await ensureBundledNodeRuntime();

function runGit(args, label) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      console.error(`[git-sync] ${label} failed to start:`, error.message);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

console.log('[git-sync] Fetching latest origin/newmain...');

const fetch = await runGit(['fetch', '--quiet', 'origin', 'newmain'], 'Git fetch');
if (fetch.code !== 0) {
  console.error(`[git-sync] Fetch failed (exit ${fetch.code}): ${fetch.stderr.trim() || 'unknown error'}`);
  console.error('[git-sync] Starting the currently installed files because the latest code could not be fetched.');
} else {
  const reset = await runGit(['reset', '--hard', 'origin/newmain'], 'Git reset');
  if (reset.code !== 0) {
    console.error(`[git-sync] Reset failed (exit ${reset.code}): ${reset.stderr.trim() || 'unknown error'}`);
    console.error('[git-sync] Starting the currently installed files.');
  } else {
    console.log('[git-sync] Synchronized tracked files to origin/newmain.');
  }
}

try {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  console.log(`[git-sync] Running commit ${commit}`);
} catch (error) {
  console.error('[git-sync] Could not determine deployed Git commit:', error.message);
}

console.log('[dependencies] Checking and installing production dependencies...');
const install = await new Promise(resolve => {
  const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let installOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { installOutput += chunk; });
  child.stderr.on('data', chunk => { installOutput += chunk; });
  child.on('error', error => {
    console.error('[dependencies] npm install could not start:', error.message);
    resolve({ code: null, output: installOutput });
  });
  child.on('close', code => resolve({ code, output: installOutput }));
});
if (install.code === 0) {
  console.log('[dependencies] Production dependencies are ready.');
} else {
  console.error(`[dependencies] npm install failed (exit ${install.code}).`);
  if (install.output.trim()) console.error(install.output.trim());
}

console.log('[git-sync] Starting bot application...');
await import('./bot.js');
