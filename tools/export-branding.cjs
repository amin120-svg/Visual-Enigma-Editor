'use strict'

// Developer export worker: renders the original vector mark through Chromium.
// It never loads remote content or changes the supplied Py Snake company logo.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
const branding = path.resolve(process.argv[2])

app.whenReady().then(async () => {
  const iconSvg = await fs.readFile(path.join(branding, 'vee-app-icon.svg'))
  const markSvg = await fs.readFile(path.join(branding, 'vee-mark.svg'))
  const window = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  async function render(svg, size, filename) {
    window.setContentSize(size, size)
    const src = 'data:image/svg+xml;base64,' + svg.toString('base64')
    const html = '<html><head><style>*{margin:0;padding:0}html,body,img{width:100%;height:100%;overflow:hidden;background:transparent}img{display:block}</style></head><body><img src="' + src + '"></body></html>'
    await window.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
    await window.webContents.executeJavaScript('document.images[0].decode()')
    const capture = await window.webContents.capturePage()
    const image = capture.resize({ width: size, height: size, quality: 'best' })
    await fs.writeFile(path.join(branding, filename), image.toPNG())
  }
  for (const size of [32, 64, 192, 256, 512]) await render(iconSvg, size, 'vee-icon-' + size + '.png')
  await render(markSvg, 512, 'vee-logo.png')
  const png = await fs.readFile(path.join(branding, 'vee-icon-256.png'))
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  await fs.writeFile(path.join(branding, 'vee-icon.ico'), Buffer.concat([header, png]))
  window.destroy()
  console.log(JSON.stringify({ success: true, branding, sizes: [32, 64, 192, 256, 512] }))
  app.exit(0)
}).catch(error => {
  console.error(error.message)
  app.exit(1)
})
