// Compile the app icon, made in Icon Composer (resources/Ollmost.icon), for packaging: Assets.car for macOS 26 and
// later, which draw it with Liquid Glass and in the dark, tinted and clear styles, and icon.icns for older macOS.
// Both are committed, so building the app doesn't need Xcode. Run this (with Xcode 26 or later) when the icon changes.
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// actool comes with Xcode, not the Command Line Tools, which xcode-select may still point to.
const xcode = '/Applications/Xcode.app/Contents/Developer'
const env = { ...process.env }
if (!env.DEVELOPER_DIR && existsSync(xcode)) env.DEVELOPER_DIR = xcode

const tmp = mkdtempSync(join(tmpdir(), 'ollmost-icon-'))
try {
  // actool names the icon after its file, and CFBundleIconName in electron-builder.yml asks for "Icon".
  const icon = join(tmp, 'Icon.icon')
  cpSync('resources/Ollmost.icon', icon, { recursive: true })
  // The same arguments electron-builder uses when it compiles a .icon itself.
  execFileSync(
    'xcrun',
    [
      'actool',
      icon,
      '--compile',
      tmp,
      '--output-format',
      'human-readable-text',
      '--notices',
      '--warnings',
      '--output-partial-info-plist',
      join(tmp, 'info.plist'),
      '--app-icon',
      'Icon',
      '--include-all-app-icons',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '26.0',
      '--platform',
      'macosx'
    ],
    { env, stdio: 'inherit' }
  )
  copyFileSync(join(tmp, 'Assets.car'), 'resources/Assets.car')
  copyFileSync(join(tmp, 'Icon.icns'), 'resources/icon.icns')
  console.log('Wrote resources/Assets.car and resources/icon.icns')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
