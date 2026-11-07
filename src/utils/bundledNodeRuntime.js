import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';

const BUNDLED_NODE_VERSION = '22.23.4';
const BUNDLED_NODE_CHECKSUMS = {
  'linux-x64': 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  'linux-x64-musl': '63189402eaa222aabf51b4983e512592131cd2d4a9efc3ad9bf291fe74e3e4de',
};

function nodeMeetsVoiceRequirement(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 22 || (major === 22 && (minor > 12 || (minor === 12 && patch >= 0)));
}

async function findOrInstallRuntime() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The bundled runtime installer currently supports Linux x64 only.');
  }

  let runtimeVariant = 'linux-x64';
  try {
    const glibcVersion = process.report?.getReport?.().header?.glibcVersionRuntime;
    if (!glibcVersion) runtimeVariant = 'linux-x64-musl';
  } catch {
    runtimeVariant = 'linux-x64-musl';
  }

  const checksum = BUNDLED_NODE_CHECKSUMS[runtimeVariant];
  const archiveName = 'node-v' + BUNDLED_NODE_VERSION + '-' + runtimeVariant + '.tar.gz';
  const archiveUrl = 'https://nodejs.org/dist/v' + BUNDLED_NODE_VERSION + '/' + archiveName;
  const cacheRoot = join(process.cwd(), '.cache', 'wolf-squad-runtime');
  const runtimeDirectory = join(cacheRoot, 'node-v' + BUNDLED_NODE_VERSION + '-' + runtimeVariant);
  const runtimeBinary = join(runtimeDirectory, 'bin', 'node');

  try {
    await access(runtimeBinary);
    const cachedVersion = spawnSync(runtimeBinary, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (!cachedVersion.error && cachedVersion.status === 0 && cachedVersion.stdout.trim() === 'v' + BUNDLED_NODE_VERSION) {
      console.log('[runtime] Reusing cached Node.js ' + BUNDLED_NODE_VERSION + '.');
      return runtimeBinary;
    }
  } catch {
    // No valid cached runtime; download it below.
  }

  await mkdir(cacheRoot, { recursive: true });
  const installDirectory = await mkdtemp(join(cacheRoot, '.install-'));
  const archivePath = join(installDirectory, archiveName);
  const extractDirectory = join(installDirectory, 'extracted');

  try {
    console.log('[runtime] Host Node.js ' + process.version + ' is too old for jail voice playback.');
    console.log('[runtime] Downloading official Node.js ' + BUNDLED_NODE_VERSION + ' runtime (' + runtimeVariant + ').');

    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) {
      throw new Error('Node.js download failed with HTTP ' + response.status + '.');
    }

    const hash = createHash('sha256');
    const hashStream = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), hashStream, createWriteStream(archivePath));
    const actualChecksum = hash.digest('hex');
    if (actualChecksum !== checksum) {
      throw new Error('Node.js archive SHA-256 verification failed.');
    }
    console.log('[runtime] Verified Node.js archive SHA-256.');

    await mkdir(extractDirectory, { recursive: true });
    const archiveTopLevel = archiveName.replace(/\.tar\.gz$/, '');
    const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', extractDirectory, '--strip-components=1', archiveTopLevel + '/bin/node'], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 5 * 1024 * 1024,
    });
    if (extraction.error || extraction.status !== 0) {
      throw new Error('Could not extract Node.js runtime: ' + (extraction.error?.message || extraction.stderr || 'tar exited with code ' + extraction.status));
    }

    const stagedBinary = join(extractDirectory, 'bin', 'node');
    const stagedVersion = spawnSync(stagedBinary, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (stagedVersion.error || stagedVersion.status !== 0 || stagedVersion.stdout.trim() !== 'v' + BUNDLED_NODE_VERSION) {
      throw new Error('Downloaded Node.js runtime failed its startup check: ' + (stagedVersion.error?.message || stagedVersion.stderr || stagedVersion.stdout));
    }

    await rm(runtimeDirectory, { recursive: true, force: true });
    await rename(extractDirectory, runtimeDirectory);
    console.log('[runtime] Installed bundled Node.js ' + BUNDLED_NODE_VERSION + '.');
    return runtimeBinary;
  } finally {
    await rm(installDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function relaunchWithRuntime(runtimeBinary) {
  console.log('[runtime] Relaunching application with bundled Node.js ' + BUNDLED_NODE_VERSION + '.');
  const child = spawn(runtimeBinary, process.argv.slice(1), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WOLF_SQUAD_BUNDLED_NODE_ACTIVE: '1',
      PATH: dirname(runtimeBinary) + ':' + (process.env.PATH || ''),
    },
    stdio: 'inherit',
  });

  const forwardSignal = signal => {
    if (!child.killed) child.kill(signal);
  };
  const onSigterm = () => forwardSignal('SIGTERM');
  const onSigint = () => forwardSignal('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  const outcome = await new Promise(resolve => {
    let settled = false;
    child.once('error', error => {
      if (settled) return;
      settled = true;
      resolve({ error });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });

  process.removeListener('SIGTERM', onSigterm);
  process.removeListener('SIGINT', onSigint);

  if (outcome.error) {
    console.error('[runtime] Could not launch bundled Node.js: ' + outcome.error.message);
    console.error('[runtime] Falling back to the host Node.js startup.');
    return;
  }

  if (outcome.signal) {
    process.kill(process.pid, outcome.signal);
    return;
  }

  process.exit(outcome.code ?? 1);
}

export async function ensureBundledNodeRuntime() {
  if (process.env.WOLF_SQUAD_BUNDLED_NODE_ACTIVE === '1' || nodeMeetsVoiceRequirement(process.version)) {
    return;
  }

  try {
    const runtimeBinary = await findOrInstallRuntime();
    await relaunchWithRuntime(runtimeBinary);
  } catch (error) {
    console.error('[runtime] Could not prepare bundled Node.js: ' + (error?.message || String(error)));
    console.error('[runtime] Continuing with host Node.js ' + process.version + '; jail voice playback may remain unavailable.');
  }
}