// GitHub helper: one command to put this project on GitHub and build the installers.
//
//   npm run github:setup                         create a private repo, push, build a release
//   npm run github:setup -- --server https://x   ...and bake in the server address friends use
//   npm run github:server -- https://x           change the baked-in server address
//   npm run github:release                       build + publish a new release (bumps the patch version)
//
// Needs Git and the GitHub CLI:  winget install --id Git.Git  &&  winget install --id GitHub.cli
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd = 'setup', ...rest] = process.argv.slice(2)
const flag = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}

function run(bin, args, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(bin, args, {
    cwd: root,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: false
  })
  if (r.error?.code === 'ENOENT') return { ok: false, missing: true, out: '' }
  const ok = r.status === 0
  if (!ok && !allowFail) {
    console.error(`\nError: ${bin} ${args.join(' ')} failed${capture ? `:\n${r.stderr || r.stdout}` : ''}`)
    process.exit(1)
  }
  return { ok, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const step = (m) => console.log(`\n> ${m}`)

function requireTools() {
  const missing = []
  if (run('git', ['--version'], { capture: true, allowFail: true }).missing) missing.push('Git:        winget install --id Git.Git -e')
  if (run('gh', ['--version'], { capture: true, allowFail: true }).missing) missing.push('GitHub CLI: winget install --id GitHub.cli -e')
  if (missing.length) {
    console.error('Install these first, then open a NEW terminal and re-run:\n  ' + missing.join('\n  '))
    console.error('(macOS: brew install git gh)')
    process.exit(1)
  }
}

function ensureLogin() {
  const status = run('gh', ['auth', 'status'], { capture: true, allowFail: true })
  const text = `${status.out}\n${status.err}`
  if (!status.ok) {
    step('Signing in to GitHub (a browser window will open)')
    run('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow'])
  } else if (!/workflow/.test(text)) {
    step('Granting permission to push the build workflow (browser window)')
    run('gh', ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'workflow'])
  }
  run('gh', ['auth', 'setup-git'], { capture: true })
}

function ensureWorkflow() {
  const dest = join(root, '.github', 'workflows', 'build.yml')
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(root, 'ci', 'github-build.yml'), dest)
}

function ensureGitIdentity() {
  const name = run('git', ['config', 'user.name'], { capture: true, allowFail: true }).out
  const email = run('git', ['config', 'user.email'], { capture: true, allowFail: true }).out
  if (name && email) return
  const me = JSON.parse(run('gh', ['api', 'user'], { capture: true }).out)
  if (!name) run('git', ['config', 'user.name', me.name || me.login])
  if (!email) run('git', ['config', 'user.email', `${me.id}+${me.login}@users.noreply.github.com`])
}

function commitAll(message) {
  run('git', ['add', '-A'])
  const dirty = !run('git', ['diff', '--cached', '--quiet'], { allowFail: true }).ok
  if (dirty) run('git', ['commit', '-m', message])
}

function setServer(url) {
  if (!/^https:\/\//.test(url)) {
    console.error('The server address must start with https:// (use the Tailscale Funnel address).')
    process.exit(1)
  }
  step(`Baking in server address ${url}`)
  run('gh', ['variable', 'set', 'GAME_SERVER_URL', '--body', url])
}

function bumpPatch() {
  const pkgPath = join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const [a, b, c] = pkg.version.split('.').map(Number)
  pkg.version = `${a}.${b}.${c + 1}`
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  return pkg.version
}

function release(version) {
  const tag = `v${version}`
  if (run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { capture: true, allowFail: true }).ok) {
    console.error(`Tag ${tag} already exists. Run "npm run github:release" to bump the version.`)
    process.exit(1)
  }
  step(`Tagging ${tag} and starting the installer build`)
  run('git', ['tag', tag])
  run('git', ['push', 'origin', 'HEAD', tag])
  const repo = run('gh', ['repo', 'view', '--json', 'url', '-q', '.url'], { capture: true }).out
  console.log(`\nBuild started. It takes about 10 minutes.`)
  console.log(`  Watch it:      gh run watch   (or ${repo}/actions)`)
  console.log(`  Installers:    ${repo}/releases/tag/${tag}`)
}

requireTools()
ensureLogin()

if (cmd === 'setup') {
  const name = flag('name') ?? 'whose-is-it'
  ensureWorkflow()
  if (!existsSync(join(root, '.git'))) {
    step('Creating local git repository')
    run('git', ['init', '-b', 'main'])
  }
  ensureGitIdentity()
  commitAll('Whose Is It')
  const hasRemote = run('git', ['remote', 'get-url', 'origin'], { capture: true, allowFail: true }).ok
  if (!hasRemote) {
    step(`Creating private GitHub repo "${name}"`)
    run('gh', ['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin', '--push'])
  } else {
    run('git', ['push', '-u', 'origin', 'HEAD'])
  }
  const server = flag('server')
  if (server) setServer(server)
  else console.log('\n(i) No server address baked in yet. Friends will be asked for it. Add one later with:\n    npm run github:server -- https://your-pc.your-tailnet.ts.net')
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  release(version)
} else if (cmd === 'server') {
  const url = rest.find((a) => !a.startsWith('--'))
  if (!url) {
    console.error('Usage: npm run github:server -- https://your-pc.your-tailnet.ts.net')
    process.exit(1)
  }
  setServer(url)
  console.log('\nNow run "npm run github:release" so new installers include it.')
} else if (cmd === 'release') {
  ensureWorkflow()
  const version = bumpPatch()
  commitAll(`Release v${version}`)
  release(version)
} else {
  console.error(`Unknown command "${cmd}". Use setup, server or release.`)
  process.exit(1)
}
