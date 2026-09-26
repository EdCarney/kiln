// Build, package and install Ollmost into /Applications (replacing any previous copy), then open it.
// Set OLLMOST_INSTALL_DIR to install somewhere else, e.g. OLLMOST_INSTALL_DIR=~/Applications.
// Your data in ~/Library/Application Support/Ollmost is untouched.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const running = () => {
  try {
    execFileSync('pgrep', ['-f', 'Ollmost.app/Contents/MacOS/Ollmost'])
    return true
  } catch {
    return false
  }
}
// Kiln was renamed Ollmost (#60): Ollmost moves Kiln's data on its first launch, which needs Kiln closed.
const kilnRunning = () => {
  try {
    execFileSync('pgrep', ['-f', 'Kiln.app/Contents/MacOS/Kiln'])
    return true
  } catch {
    return false
  }
}
const bundleId = (app) => {
  try {
    return execFileSync('defaults', ['read', join(app, 'Contents', 'Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

run('npx electron-vite build')
run('npx electron-builder --mac --dir')

// --dir packages only this machine's architecture, but `npm run dist` leaves both chips' builds
// in dist/ (x64 in dist/mac), so pick this one explicitly.
const built = join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Ollmost.app')
if (!existsSync(built)) throw new Error(`Packaged Ollmost.app not found at ${built}`)
// Expand a quoted ~ ("~/Applications"), which the shell leaves alone.
const installDir = resolve((process.env.OLLMOST_INSTALL_DIR || '/Applications').replace(/^~(?=$|\/)/, homedir()))
mkdirSync(installDir, { recursive: true })
const target = join(installDir, 'Ollmost.app')

if (running()) {
  execFileSync('osascript', ['-e', 'quit app "Ollmost"'])
  for (let i = 0; i < 20 && running(); i++) execSync('sleep 0.5')
}
if (kilnRunning()) {
  execFileSync('osascript', ['-e', 'quit app "Kiln"'])
  for (let i = 0; i < 20 && kilnRunning(); i++) execSync('sleep 0.5')
  if (kilnRunning()) throw new Error('Kiln is still running. Quit it and run this again.')
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [built, target])
execFileSync('open', [target])
console.log(`Installed ${target}`)

// Remove Kiln.app once Ollmost has moved Kiln's data, and only if it really is Kiln.
const oldApp = join(installDir, 'Kiln.app')
const oldDb = join(homedir(), 'Library', 'Application Support', 'Kiln', 'kiln.db')
if (existsSync(oldApp) && bundleId(oldApp) === 'local.kiln.app') {
  for (let i = 0; i < 120 && existsSync(oldDb); i++) execSync('sleep 0.5')
  if (existsSync(oldDb))
    console.log(`Kept ${oldApp}: your Kiln data hasn't moved yet. Open Ollmost, and delete Kiln.app once your chats show up.`)
  else {
    rmSync(oldApp, { recursive: true, force: true })
    console.log(`Removed ${oldApp} (Kiln is now Ollmost)`)
  }
}
