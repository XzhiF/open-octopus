// ponytail: browser stub for Node builtins — @octopus/shared imports fs/path/os/child_process
// but only os.homedir() runs at module eval time. Other methods are inside functions that
// never execute client-side. Provide enough surface to not crash on import.
function noop() { return '' }
function identity(x) { return x }
function joinImpl() { return Array.from(arguments).filter(Boolean).join('/') }

export function homedir() { return '/tmp' }
export function tmpdir() { return '/tmp' }
export function platform() { return 'browser' }
export function arch() { return 'x64' }
export const EOL = '\n'

export function join() { return joinImpl.apply(null, arguments) }
export function basename(p) { return p ? p.split('/').pop() : '' }
export function dirname(p) { return p ? p.replace(/\/[^/]*$/, '') || '/' : '.' }
export function resolve() { return joinImpl.apply(null, arguments) }
export function isAbsolute(p) { return p && p[0] === '/' }
export function extname(p) { const m = p && p.match(/\.[^.]+$/); return m ? m[0] : '' }
export const sep = '/'

export function readFileSync() { return '' }
export function existsSync() { return false }
export function readdirSync() { return [] }
export function statSync() { return { isFile: () => false, isDirectory: () => false, size: 0 } }
export function mkdirSync() {}
export function writeFileSync() {}

export async function readFile() { return '' }
export async function readdir() { return [] }

export function spawnSync() { return { status: 0, stdout: '', stderr: '' } }
export function execFileSync() { return '' }
export function execSync() { return '' }
export function fork() { return null }

// events
export class EventEmitter {
  on() { return this }
  off() { return this }
  emit() { return false }
  once() { return this }
  removeAllListeners() { return this }
  addListener() { return this }
  removeListener() { return this }
}

// crypto — default import: `import crypto from "crypto"`
export function randomUUID() { return '00000000-0000-0000-0000-000000000000' }
export function createHash() { return { update: () => ({ digest: () => '0000000000' }) } }
export function createCipheriv() { return { update: () => '', final: () => '' } }
export function createDecipheriv() { return { update: () => '', final: () => '' } }
export function randomBytes(n) { return new Uint8Array(n) }
const _default = {
  homedir, tmpdir, platform, arch, EOL,
  join: joinImpl, basename, dirname, resolve, isAbsolute, extname, sep,
  readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync,
  spawnSync, execFileSync, execSync, fork,
  randomUUID, createHash, createCipheriv, createDecipheriv, randomBytes,
}
export default _default
