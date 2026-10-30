// Repeatable local packager: pnpm pack at repo root follows .gitignore and excludes dist.
// Build first, stage only approved plugin files outside Git, then verify the tarball.
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = join(root, 'test')
const options = process.argv.slice(2)
const isPublish = options.includes('--publish')
const isDryRun = options.includes('--dry-run')
const outputArg = options.find((arg) => !arg.startsWith('--'))
const out = resolve(outputArg || join(testRoot, 'lite-release-packages'))
await mkdir(testRoot, { recursive: true })
await mkdir(out, { recursive: true })
const stage = await mkdtemp(join(testRoot, 'pack-stage-'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (!/^workspace-organizer-dsh$/.test(pkg.name)) throw new Error('unexpected package name')
if (!/^[\w.-]+$/.test(pkg.version)) throw new Error('invalid package version')

try {
  for (const entry of ['dist', 'client', 'src']) {
    await cp(join(root, entry), join(stage, entry), { recursive: true, dereference: true })
  }
  for (const entry of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
    await cp(join(root, entry), join(stage, entry))
  }
  await stat(join(stage, 'dist', 'index.js'))
  await stat(join(stage, 'client', 'client.js'))
  const pmEntrypoint = process.env.npm_execpath
  if (!pmEntrypoint) throw new Error('Run this packager through pnpm run pack:plugin')
  const call = spawnSync(process.execPath, [pmEntrypoint, 'pack', '--pack-destination', out], {
    cwd: stage, shell: false, stdio: 'inherit'
  })
  if (call.status !== 0) throw new Error('pnpm pack failed: ' + String(call.status))
  const archive = join(out, pkg.name + '-' + pkg.version + '.tgz')
  const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
  if (listing.status !== 0) throw new Error('failed to inspect tarball')
  const members = new Set(listing.stdout.split(/\r?\n/))
  for (const entry of ['package/dist/index.js', 'package/client/client.js', 'package/package.json', 'package/README.md', 'package/LICENSE']) {
    if (!members.has(entry)) throw new Error('packaged file missing: ' + entry)
  }
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  console.log('Verified plugin archive: ' + archive)
  console.log('SHA-256: ' + sha256)
  if (isPublish) {
    if (pkg.private === true || pkg.publishConfig?.tag !== 'preview') {
      throw new Error('preview publish requires public package with publishConfig.tag=preview')
    }
    // Publish *from stage*, not root; otherwise ignored junctions may omit dist/.
    const args = [pmEntrypoint, 'publish', '--tag', 'preview', '--access', 'public', '--no-git-checks']
    if (isDryRun) args.push('--dry-run')
    const published = spawnSync(process.execPath, args, { cwd: stage, shell: false, stdio: 'inherit' })
    if (published.status !== 0) throw new Error('preview publish failed: ' + String(published.status))
  }
} finally {
  await rm(stage, { recursive: true, force: true })
}
