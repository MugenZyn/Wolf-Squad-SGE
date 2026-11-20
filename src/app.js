import 'dotenv/config';
import { ensureBundledNodeRuntime } from './utils/bundledNodeRuntime.js';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function getMissingProductionDependencies() {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const missing = [];

  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    const lockEntry = lockfile.packages?.['node_modules/' + name];
    const expectedVersion = lockEntry?.version;
    const packagePath = join(root, 'node_modules', ...name.split('/'), 'package.json');
    if (!expectedVersion) {
      missing.push(name + ' (missing lockfile entry)');
      continue;
    }

    try {
      const installed = JSON.parse(await readFile(packagePath, 'utf8'));
      if (installed.version !== expectedVersion) {
        missing.push(name + ' (installed ' + (installed.version || 'unknown') + ', expected ' + expectedVersion + ')');
      }
    } catch {
      missing.push(name + ' (not installed)');
    }
  }

  // ffmpeg-static has a postinstall download; checking only package.json
  // would miss an install where the binary download never completed.
  try {
    const { default: ffmpegPath } = await import('ffmpeg-static');
    if (typeof ffmpegPath !== 'string' || !ffmpegPath) {
      missing.push('ffmpeg-static (binary path unavailable)');
    } else {
      await access(ffmpegPath);
    }
  } catch {
    missing.push('ffmpeg-static (binary missing or inaccessible)');
  }

  return [...new Set(missing)];
}

console.log('[dependencies] Checking installed production dependencies...');
let missingDependencies = [];
try {
  missingDependencies = await getMissingProductionDependencies();
} catch (error) {
  console.warn('[dependencies] Could not verify installed packages:', error?.message ?? String(error));
  missingDependencies = ['dependency verification failed'];
}

if (missingDependencies.length === 0) {
  console.log('[dependencies] Existing production dependencies match package-lock.json; skipping npm install.');
} else {
  console.log('[dependencies] Installing or repairing ' + missingDependencies.length + ' production dependency package(s):');
  for (const dependency of missingDependencies.slice(0, 20)) {
    console.log('[dependencies] - ' + dependency);
  }
  if (missingDependencies.length > 20) {
    console.log('[dependencies] - and ' + (missingDependencies.length - 20) + ' more');
  }

  const install = await new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    const child = spawn('npm', [
      'install', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts',
    ], {
      cwd: root,
      stdio: 'inherit',
    });

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error('[dependencies] npm install exceeded 180 seconds; stopping it and continuing with the currently installed packages.');
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 10000);
      forceKill.unref?.();
    }, 180000);
    timeout.unref?.();

    child.once('error', error => finish({ code: null, error }));
    child.once('close', code => finish({ code, timedOut }));
  });

  if (install.error) {
    console.error('[dependencies] npm install could not start:', install.error.message);
  } else if (install.code === 0) {
    console.log('[dependencies] Production dependencies are ready.');
  } else if (!install.timedOut) {
    console.error('[dependencies] npm install failed (exit ' + install.code + '). Starting with currently installed packages.');
  }
}

console.log('[git-sync] Starting bot application...');
await import('./bot.js');
