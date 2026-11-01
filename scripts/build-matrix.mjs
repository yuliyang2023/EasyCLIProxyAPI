import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildMatrix(target = 'all') {
  const include = [
    { runner: 'ubuntu-22.04', os: 'linux', display_os: 'Linux', arch: 'amd64', suffix: 'tar.gz' },
    { runner: 'ubuntu-22.04-arm', os: 'linux', display_os: 'Linux', arch: 'aarch64', suffix: 'tar.gz' },
    { runner: 'macos-15-intel', os: 'darwin', display_os: 'Darwin', arch: 'amd64', suffix: 'dmg' },
    { runner: 'macos-15', os: 'darwin', display_os: 'Darwin', arch: 'aarch64', suffix: 'dmg' },
    { runner: 'windows-2025', os: 'windows', display_os: 'Windows', arch: 'amd64', suffix: 'zip' },
    { runner: 'windows-11-arm', os: 'windows', display_os: 'Windows', arch: 'aarch64', suffix: 'zip' },
  ];
  if (target === 'all') return { include };
  if (target === 'macos-intel') return { include: include.filter(job => job.os === 'darwin' && job.arch === 'amd64') };
  throw new Error(`Unsupported build target: ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(buildMatrix(process.argv[2] ?? 'all'))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
