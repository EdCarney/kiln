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
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [built, target])
execFileSync('open', [target])
console.log(`Installed ${target}`)
