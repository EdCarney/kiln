// Build, package and install Kiln into /Applications (replacing any previous copy), then open it.
// Your data in ~/Library/Application Support/Kiln is untouched.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
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

const distDir = readdirSync('dist').find((d) => d.startsWith('mac') && existsSync(join('dist', d, 'Kiln.app')))
if (!distDir) throw new Error('Packaged Kiln.app not found under dist/')
const built = join('dist', distDir, 'Kiln.app')
const target = '/Applications/Kiln.app'

if (running()) {
  execFileSync('osascript', ['-e', 'quit app "Kiln"'])
  for (let i = 0; i < 20 && running(); i++) execSync('sleep 0.5')
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [built, target])
execFileSync('open', [target])
console.log(`Installed ${target}`)
