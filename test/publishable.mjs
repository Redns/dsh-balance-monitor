/**
 * Publishability check: can another device install this package from a git
 * clone (GitHub) and have DSH actually load it?
 *
 * The three ways a plugin looks fine locally but fails on a fresh clone are:
 *
 *   1. the manifest declares peerDependencies it cannot satisfy. The DSH plugin
 *      manager judges git/tarball installs *after* fetching, by reading the
 *      installed manifest's peers against the running DSH version — a peer
 *      range that does not match lands the install on the `incompatible-version`
 *      path and needs `dsh plugin allow-version <pkg>@<v> --dsh-version <v>
 *      --accept-risk`. Declaring peers you do not use is therefore a real cost
 *      for every installer.
 *   2. a `prepare` / build script. pnpm blocks those for git-hosted packages
 *      until the exact key is added to the profile's `pnpm-workspace.yaml`
 *      `allowBuilds`, so the install fails until the user hand-edits it.
 *   3. a `files`/exports whitelist that drops something the loader needs — the
 *      host entry, the client bundle, or the bundle patch file.
 *
 * Run with: node test/publishable.mjs
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

console.log(`# package ${pkg.name}@${pkg.version}`)

// ---------------------------------------------------------------------------
// 1. No peer requirements, no build steps.
// ---------------------------------------------------------------------------

const peers = Object.keys(pkg.peerDependencies ?? {})
check('declares no peerDependencies', peers.length === 0, peers.join(', '))
check('declares no dependencies', Object.keys(pkg.dependencies ?? {}).length === 0,
  Object.keys(pkg.dependencies ?? {}).join(', '))
check('declares no optionalDependencies', Object.keys(pkg.optionalDependencies ?? {}).length === 0)

const BUILD_SCRIPTS = ['prepare', 'preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly']
const buildScripts = BUILD_SCRIPTS.filter((name) => (pkg.scripts ?? {})[name] !== undefined)
check('declares no build/prepare scripts', buildScripts.length === 0, buildScripts.join(', '))

// A git-hosted install has no build step, so the shipped JS must be the final
// artefact — i.e. lib/*.js must exist as committed files, not TypeScript.
const mainPath = typeof pkg.main === 'string' ? pkg.main : pkg.exports?.['.']
check('host entry is plain committed JS', typeof mainPath === 'string' && mainPath.endsWith('.js'), String(mainPath))
check('host entry exists on disk', typeof mainPath === 'string' && existsSync(join(root, mainPath)), String(mainPath))

// ---------------------------------------------------------------------------
// 2. The dsh declarations the loader reads.
// ---------------------------------------------------------------------------

check('declares dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string', JSON.stringify(pkg.dsh?.bundle))
check('declares dsh.client for the browser half', pkg.dsh?.client !== undefined, JSON.stringify(pkg.dsh?.client))
check('client platform is web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))

const patchRel = pkg.dsh?.bundle?.patch
const patchPath = typeof patchRel === 'string' ? join(root, patchRel) : null
check('bundle patch file exists', patchPath !== null && existsSync(patchPath), String(patchRel))

if (patchPath !== null && existsSync(patchPath)) {
  const patchText = await readFile(patchPath, 'utf8')
  // The loader entry inside the patch must name THIS package, or nothing loads.
  check('patch inserts an entry naming this package', patchText.includes(`name: '${pkg.name}'`) || patchText.includes(`name: "${pkg.name}"`),
    patchText.replace(/\n/g, ' ').slice(0, 120))
  check('patch injects the credentials service', /inject:\s*\[credentials\]/.test(patchText), '')
  check('patch does not wait on webServer',
    !/inject:\s*\[[^\]]*webServer/.test(patchText),
    'a webServer row stays pending forever on the desktop composition')
}

// The client bundle must be reachable through the exports map the loader uses.
const clientExport = pkg.exports?.['./client']
check('exports "./client"', typeof clientExport === 'string' && clientExport.endsWith('.js'), String(clientExport))
check('client bundle exists on disk', typeof clientExport === 'string' && existsSync(join(root, clientExport)), String(clientExport))

if (typeof clientExport === 'string' && existsSync(join(root, clientExport))) {
  const client = await readFile(join(root, clientExport), 'utf8')
  // dsh-client-modules registers the bundle by the id inside the bundle, and
  // the page requests it by package name — a mismatch 404s the whole half.
  const idMatch = /id:\s*['"]([^'"]+)['"]/.exec(client)
  check('client bundle self-registers under the package name',
    idMatch !== null && idMatch[1] === pkg.name, idMatch === null ? 'no id found' : idMatch[1])
  check('client bundle uses window.__ModuleLoader__.load',
    client.includes('__ModuleLoader__.load'), '')
}

// ---------------------------------------------------------------------------
// 3. Nothing needed by the loader is excluded by `files`.
// ---------------------------------------------------------------------------

const files = pkg.files ?? []
check('files whitelist is present', files.length > 0, JSON.stringify(files))
const required = [mainPath, clientExport, patchRel].filter((x) => typeof x === 'string')
for (const rel of required) {
  const top = rel.replace(/^\.\//, '').split('/')[0]
  const covered = files.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return clean === top || rel.startsWith(`${clean}/`)
  })
  check(`files whitelist covers ${rel}`, covered, `files=[${files.join(', ')}]`)
}

// Documentation the repo references should also be pushed.
for (const doc of ['README.md', 'LICENSE']) {
  check(`${doc} is tracked for the repo`, existsSync(join(root, doc)), '')
}

console.log(`\n${failures === 0 ? 'PUBLISHABLE OK' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
