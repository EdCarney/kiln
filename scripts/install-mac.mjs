// Build, package and install Kiln into /Applications (replacing any previous copy), then open it.
// Your data in ~/Library/Application Support/Kiln is untouched.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const running = () => {
  try {
    execFileSync('pgrep', ['-f', 'Kiln.app/Contents/MacOS/Kiln'])
    return true
  } catch {
    return false
  }
}

run('npx electron-vite build')
run('npx electron-builder --mac --dir')

// --dir packages only this machine's architecture, but `npm run dist` leaves both chips' builds
// in dist/ (x64 in dist/mac), so pick this one explicitly.
const built = join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Kiln.app')
if (!existsSync(built)) throw new Error(`Packaged Kiln.app not found at ${built}`)
const target = '/Applications/Kiln.app'

if (running()) {
  execFileSync('osascript', ['-e', 'quit app "Kiln"'])
  for (let i = 0; i < 20 && running(); i++) execSync('sleep 0.5')
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [built, target])
execFileSync('open', [target])
console.log(`Installed ${target}`)
