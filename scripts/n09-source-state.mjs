// Fingerprint only the fixed runner sources, never credentials or analysis inputs.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const SOURCE_FILES = Object.freeze([
  'rea-smoke.mjs', 'n09-contract.mjs', 'n09-prepare.mjs',
  'n09-live.mjs', 'n09-check-pair.mjs', 'n09-source-state.mjs',
  'wire-spec.mjs', 'n12-practice-bridge.mjs', 'gemini-practice.mjs', 'gemini-pilot.mjs',
  'pcap-tcp-streams.py',
]);
const sha = value => createHash('sha256').update(value).digest('hex');

export async function fingerprintSources() {
  const files = await Promise.all(SOURCE_FILES.map(async name => {
    const bytes = await readFile(new URL(name, import.meta.url));
    return { path: `scripts/${name}`, bytes: bytes.length, sha256: sha(bytes) };
  }));
  return { algorithm: 'sha256', files, sha256: sha(JSON.stringify(files)) };
}
