'use strict'

// Real packaged main/preload/workspace, temporary profile, zero external calls.
const { app, BrowserWindow, session, nativeTheme } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const appRoot = process.env.VEE_QA_APP_ROOT
const outputRoot = process.env.VEE_QA_OUTPUT_ROOT
const userData = process.env.VEE_QA_USER_DATA
if (!appRoot || !outputRoot || !userData) throw new Error('QA paths are required')
app.setPath('userData', userData)
const result = { success:false, step:'startup', steps:[], errors:[], rendererConsoleErrors:[], blockedNetwork:[] }
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// Offline probes must fail before transport. This last-resort gate prevents a
// regression from contacting any account service, AI provider or customer VPS.
for (const moduleName of ['node:https','node:http']) {
  const transport = require(moduleName)
  for(const method of ['request','get']) transport[method] = () => {
    result.blockedNetwork.push({transport:moduleName,method})
    throw new Error('QA forbids external network requests')
  }
}
require(path.join(appRoot,'main.cjs'))
let mainWindow
async function js(source) {
  let timeout
  try {
    return await Promise.race([
      mainWindow.webContents.executeJavaScript(source,true),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`Renderer script exceeded 12 seconds in ${result.step}`)),12_000)}),
    ])
  } finally { clearTimeout(timeout) }
}
async function waitFor(check, description, timeout=15_000) {
  const deadline=Date.now()+timeout
  let lastError
  while(Date.now()<deadline) {
    try { if(await check())return } catch(error) { lastError=error.message }
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  throw new Error(`Timed out waiting for ${description}${lastError?`: ${lastError}`:''}`)
}
const waitJs=(source,description,timeout)=>waitFor(()=>js(source),description,timeout)
async function step(name,action) { result.step=name; await fs.writeFile(path.join(outputRoot,'progress.json'),JSON.stringify({step:name,completed:result.steps.length})); const started=Date.now(); const value=await action(); result.steps.push({name,durationMs:Date.now()-started}); return value }
async function screenshot(name) {
  await js(`Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))),new Promise(resolve=>setTimeout(()=>resolve(true),500))])`)
  await new Promise(resolve=>setTimeout(resolve,250))
  await fs.writeFile(path.join(outputRoot,`${name}.png`),(await mainWindow.webContents.capturePage()).toPNG())
}
async function helpers() {
  await js(`window.__qa={
    click(selector){const node=document.querySelector(selector);if(!node)throw new Error('Missing '+selector);if(node.disabled)throw new Error('Disabled '+selector);node.click()},
    button(scope,text){const node=Array.from(document.querySelectorAll(scope+' button')).find(item=>item.textContent.trim()===text);if(!node)throw new Error('Missing button '+scope+' / '+text);if(node.disabled)throw new Error('Disabled '+text);node.click()},
    set(selector,value){const node=document.querySelector(selector);if(!node)throw new Error('Missing field '+selector);const proto=node instanceof HTMLSelectElement?HTMLSelectElement.prototype:node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new Event(node instanceof HTMLSelectElement?'change':'input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))},
    field(label,value){const container=Array.from(document.querySelectorAll('.builder-inspector label.builder-field')).find(item=>item.querySelector('span')?.childNodes[0]?.textContent.trim()===label);const node=container?.querySelector('input,textarea,select');if(!node)throw new Error('Missing builder field '+label);node.dataset.qaField='active';this.set('[data-qa-field="active"]',value);delete node.dataset.qaField},
    monaco(){return new Promise((resolve,reject)=>window.require(['vs/editor/editor.main'],()=>resolve(window.monaco),reject))}
  };true`)
}
async function appearance(value) {
  await js(`__qa.set('[data-qa="appearance"]',${JSON.stringify(value)})`)
  await waitJs(`document.querySelector('.desktop-app')?.dataset.theme===${JSON.stringify(value)}`,`${value} appearance`)
  await waitJs(`!document.querySelector('.monaco-editor') || document.querySelector('.monaco-editor').classList.contains(${JSON.stringify(value === 'light' ? 'vs' : 'vs-dark')})`,`${value} Monaco theme`)
  return js(`(()=>{const root=document.querySelector('.desktop-app');const editor=document.querySelector('.monaco-editor');return{appearance:root.dataset.appearance,theme:root.dataset.theme,storage:localStorage.getItem('vee.desktop.appearance'),background:getComputedStyle(root).backgroundColor,foreground:getComputedStyle(root).color,editorTheme:editor?.className||'',editorBackground:editor?getComputedStyle(editor).backgroundColor:null}})()`)
}
async function createProject(name,starter) {
  await js(`__qa.click('[data-qa="new-project"]')`)
  await waitJs(`Boolean(document.querySelector('#desktop-project-name'))`,'new project form')
  await js(`__qa.set('#desktop-project-name',${JSON.stringify(name)})`)
  await js(`__qa.set('#desktop-project-starter',${JSON.stringify(starter)})`)
  await js(`document.querySelector('.desktop-create').requestSubmit()`)
  await waitJs(`!document.querySelector('.desktop-create')&&document.querySelector('.desktop-location')?.textContent.includes(${JSON.stringify(name)})`,`project ${name}`)
  await waitJs(`Boolean(document.querySelector('.monaco-editor .view-lines'))`,'bundled Monaco',35_000)
  const item=await js(`veeDesktop.listProjects().then(items=>items.find(item=>item.name===${JSON.stringify(name)}))`)
  if(!item)throw new Error('Project did not persist')
  return item
}
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(outputRoot,{recursive:true})
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{result.blockedNetwork.push({transport:'chromium',url:details.url});callback({cancel:true})})
    await waitFor(()=>BrowserWindow.getAllWindows().length>0,'production BrowserWindow')
    mainWindow=BrowserWindow.getAllWindows()[0]
    mainWindow.webContents.setBackgroundThrottling(false)
    result.workerRequests=[]
    session.defaultSession.webRequest.onCompleted(details=>{if(details.url.includes('/monaco/'))result.workerRequests.push({url:details.url,status:details.statusCode,resource:details.resourceType})})
    session.defaultSession.webRequest.onErrorOccurred(details=>{if(details.url.includes('/monaco/'))result.workerRequests.push({url:details.url,error:details.error,resource:details.resourceType})})
    mainWindow.webContents.on('console-message',event=>{
      const expected=event.message.startsWith("Blocked script execution in 'about:srcdoc'")&&event.message.includes("the 'allow-scripts' permission is not set")
      if(event.level==='error'&&!expected)result.rendererConsoleErrors.push(event.message)
    })
    await waitJs('Boolean(window.veeDesktop&&document.querySelector(".desktop-app"))','desktop renderer')
    await helpers()
    result.defaults=await step('English defaults and blank connections',async()=>{
      const value=await js(`(async()=>({lang:document.documentElement.lang,dir:document.documentElement.dir,projects:(await veeDesktop.listProjects()).length,agent:await veeDesktop.agentSettings(),online:await veeDesktop.onlineStatus(),starters:await veeDesktop.listProjectStarters(),welcome:document.body.innerText}))()`)
      if(value.lang!=='en'||value.dir==='rtl'||value.projects||value.agent.host!==''||value.agent.paired||value.online.baseUrl)throw new Error('First-run language, project or connection default regression')
      if(value.starters.length!==11||!value.welcome.includes('Welcome to VEE'))throw new Error('English welcome or eleven starters missing')
      delete value.welcome;return value
    })
    result.networkBoundary=await step('Offline named operations reject before transport',()=>js(`(async()=>{
      const mode=await veeDesktop.setOfflineMode(true);const rejected={};
      for(const[name,run]of Object.entries({agent:()=>veeDesktop.agentStatus(),ai:()=>veeDesktop.generateAIProposal({projectId:'not-a-project',path:'index.html',instruction:'QA offline check'}),connect:()=>veeDesktop.onlineConnect('https://qa-network-blocked.invalid'),pro:()=>veeDesktop.onlineEntitlements(),community:()=>veeDesktop.communityList()})){try{await run();rejected[name]=false}catch(error){rejected[name]=String(error.message).includes('Offline Mode')}}
      return{mode,rejected,methods:['onlineStatus','onlineConnect','onlineLogin','onlineRegister','onlineUpdateProfile','onlineEntitlements','communityList','communitySubmit','communityDownload'].every(name=>typeof veeDesktop[name]==='function')}
    })()`))
    if(!result.networkBoundary.methods||Object.values(result.networkBoundary.rejected).some(value=>!value))throw new Error('A named online operation bypassed Offline Mode')
    await js(`__qa.click('.desktop-mode-button')`)
    await waitJs(`document.querySelector('.desktop-mode-button')?.getAttribute('aria-pressed')==='true'`,'Offline Mode reflected in renderer')
    await helpers()
    result.appearance=await step('Light and dark welcome surfaces',async()=>{
      const light=await appearance('light');await screenshot('workbench-welcome-light')
      const dark=await appearance('dark');await screenshot('workbench-welcome-dark')
      if(light.background===dark.background||light.foreground===dark.foreground)throw new Error('Appearance did not change computed surface colors')
      return{light,dark}
    })
    result.systemAppearance=await step('System appearance follows app-local OS preference',async()=>{
      const previous=nativeTheme.themeSource
      try {
        nativeTheme.themeSource='light'
        await js(`__qa.set('[data-qa="appearance"]','system')`)
        await waitJs(`document.querySelector('.desktop-app')?.dataset.theme==='light'`,'system light appearance')
        nativeTheme.themeSource='dark'
        await waitJs(`document.querySelector('.desktop-app')?.dataset.theme==='dark'`,'system dark appearance')
        if(await js(`localStorage.getItem('vee.desktop.appearance')`)!=='system')throw new Error('System choice was not saved')
        return {light:true,dark:true,persisted:true}
      } finally { nativeTheme.themeSource=previous;await appearance('dark') }
    })
    await step('Eleven starter options and two real local projects',async()=>{
      await js(`__qa.click('[data-qa="new-project"]')`)
      await waitJs(`document.querySelectorAll('#desktop-project-starter option').length===11`,'eleven starter options')
      result.starterOptions=await js(`Array.from(document.querySelectorAll('#desktop-project-starter option')).map(item=>({value:item.value,label:item.textContent}))`)
      await js(`__qa.button('.desktop-create','Cancel')`)
      result.projects=[await createProject('QA Workbench Website','static'),await createProject('QA Business Website','business')]
      result.projectSources=await js(`(async()=>{const a=(await veeDesktop.readFile(${JSON.stringify(result.projects[0].id)},'index.html')).content;const b=(await veeDesktop.readFile(${JSON.stringify(result.projects[1].id)},'index.html')).content;return{staticEnglish:a.includes('lang="en"')&&a.includes('Make room for your next idea'),businessEnglish:b.includes('lang="en"')&&b.includes('What we do'),distinct:a!==b}})()`)
      if(Object.values(result.projectSources).some(value=>!value))throw new Error('Selected starters did not generate distinct English projects')
    })
    result.editorAppearance=await step('Monaco themes and appearance persistence',async()=>{
      const light=await appearance('light');await waitJs(`document.querySelector('.monaco-editor')?.classList.contains('vs')`,'light Monaco');await screenshot('workbench-code-light')
      const dark=await appearance('dark');await waitJs(`document.querySelector('.monaco-editor')?.classList.contains('vs-dark')`,'dark Monaco');await screenshot('workbench-code-dark')
      await mainWindow.loadURL('vee-app://app/index.html')
      await waitJs(`document.querySelector('.desktop-app')?.dataset.theme==='dark'&&document.querySelector('.monaco-editor')?.classList.contains('vs-dark')`,'persisted dark editor',35_000)
      await helpers()
      const persisted=await js(`({setting:document.querySelector('[data-qa="appearance"]')?.value,storage:localStorage.getItem('vee.desktop.appearance')})`)
      if(persisted.setting!=='dark'||persisted.storage!=='dark'||light.editorBackground===dark.editorBackground)throw new Error('Monaco color or appearance persistence regression')
      return{light,dark,persisted}
    })
    result.languageWorker=await step('Bundled JSON language worker responds',()=>js(`__qa.monaco().then(async m=>{
      const uri=m.Uri.parse('inmemory://vee-qa/worker-validation.json');
      const model=m.editor.createModel('{"name":"VEE"}','json',uri);
      try{const factory=await m.languages.json.getWorker();const worker=await factory(uri);const parsed=await worker.parseJSONDocument(uri.toString());return{responded:parsed?.root?.type==='object',properties:parsed?.root?.properties?.length}}finally{model.dispose()}
    })`))
    if(!result.languageWorker.responded)throw new Error('Bundled JSON parsing worker did not respond')
    result.editorWorker=await step('Bundled editor worker asset runs',async()=>{
      const assets=await fs.readdir(path.join(appRoot,'renderer/monaco/vs/assets'))
      const name=assets.find(item=>/^editor\.worker-[A-Za-z0-9_-]+\.js$/.test(item))
      if(!name)throw new Error('Editor worker asset missing')
      return js(`new Promise((resolve,reject)=>{
        const code='importScripts('+JSON.stringify('vee-app://app/monaco/vs/assets/'+${JSON.stringify(name)})+');postMessage({assetLoaded:true});';
        const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));const worker=new Worker(url);
        const stop=()=>{worker.terminate();URL.revokeObjectURL(url);clearTimeout(timer)};
        const timer=setTimeout(()=>{stop();reject(new Error('Editor worker asset timed out'))},6000);
        worker.onmessage=event=>{if(event.data?.assetLoaded){stop();resolve({loaded:true})}};
        worker.onerror=event=>{stop();reject(new Error(event.message||'Editor worker asset failed'))};
      })`)
    })
    result.unsavedNavigation=await step('Unsaved code survives Account and Community',async()=>{
      await js(`__qa.button('.desktop-files','index.html')`)
      await waitJs(`document.querySelector('.desktop-editor-tabs')?.textContent.includes('index.html')&&Boolean(document.querySelector('.monaco-editor'))`,'index editor')
      const marker='<!-- QA unsaved navigation marker -->'
      await js(`__qa.monaco().then(m=>{const model=m.editor.getModels().find(item=>item.uri.toString().includes('index.html'));if(!model)throw new Error('index model missing');model.setValue(model.getValue()+'\\n'+${JSON.stringify(marker)})})`)
      await waitJs(`document.querySelector('.desktop-status')?.textContent.includes('Unsaved')`,'code dirty state')
      await js(`__qa.click('[data-qa="nav-account"]')`)
      await waitJs(`Boolean(document.querySelector('section[aria-label="Account and Pro"]'))`,'Account and Pro')
      const account=await js(`({serviceField:!!document.querySelector('#vee-service-url'),serviceBlank:document.querySelector('#vee-service-url')?.value==='',offline:document.querySelector('.desktop-online-banner')?.textContent.includes('Offline Mode'),signIn:document.querySelector('.desktop-auth-tabs')?.textContent.includes('Sign in')})`)
      await screenshot('workbench-account-dark')
      await js(`__qa.button('.desktop-auth-tabs','Create account')`)
      const accountLanguage=await js(`Array.from(document.querySelectorAll('.desktop-online-form select')).find(item=>Array.from(item.options).some(option=>option.value==='en'))?.value`)
      await appearance('light');await screenshot('workbench-account-light');await appearance('dark')
      await js(`__qa.click('[data-qa="nav-community"]')`)
      await waitJs(`Boolean(document.querySelector('section[aria-label="Community"]'))`,'Community')
      const community=await js(`document.querySelector('section[aria-label="Community"]').textContent.includes('reusable blocks, themes')`)
      await screenshot('workbench-community-dark')
      await appearance('light');await screenshot('workbench-community-light');await appearance('dark')
      await js(`__qa.click('[data-qa="nav-projects"]')`)
      await waitJs(`!document.querySelector('.desktop-local-content')?.classList.contains('is-hidden')`,'local workspace restored')
      const retained=await js(`__qa.monaco().then(m=>m.editor.getModels().some(item=>item.getValue().includes(${JSON.stringify(marker)})))`)
      await js(`__qa.button('.desktop-editor-tabs','Save')`)
      await waitJs(`!document.querySelector('.desktop-status')?.textContent.includes('Unsaved')`,'code save')
      if(!Object.values(account).every(Boolean)||accountLanguage!=='en'||!community||!retained)throw new Error('Account navigation, language or dirty code regression')
      return{account,accountLanguage,community,retained}
    })
    result.builder=await step('Five layouts, writing tools, appearance and SEO',async()=>{
      await js(`__qa.button('.desktop-project-nav','QA Business Website')`)
      await waitJs(`document.querySelector('.desktop-location')?.textContent.includes('QA Business Website')`,'business project selected')
      await js(`__qa.click('[data-qa="build-mode"]')`)
      await waitJs(`document.querySelectorAll('.builder-starters button').length===5`,'five visual layouts')
      const layouts=await js(`Array.from(document.querySelectorAll('.builder-starters button strong')).map(item=>item.textContent)`)
      await js(`Array.from(document.querySelectorAll('.builder-starters button')).find(item=>item.querySelector('strong')?.textContent==='Personal portfolio').click()`)
      await waitJs(`document.querySelectorAll('.canvas-outline button').length===5`,'portfolio sections')
      await js(`__qa.set('#builder-body-text','Professional writing for the web')`)
      await js(`document.querySelector('#builder-body-text').focus();document.querySelector('#builder-body-text').setSelectionRange(0,12);__qa.click('[aria-label="Bold"]')`)
      await waitJs(`document.querySelector('#builder-body-text')?.value.startsWith('**Professional**')`,'selected bold writing')
      await js(`__qa.set('[aria-label="Background color"]','#ffe7b3')`)
      await js(`__qa.click('[aria-label="Center alignment"]')`)
      await js(`__qa.field('Writing direction','rtl')`)
      await js(`__qa.click('[aria-label="Right alignment"]')`)
      await js(`__qa.click('#builder-tab-page')`)
      await js(`__qa.set('[aria-label="Background color"]','#f5f2e9')`)
      await js(`__qa.click('#builder-tab-seo')`)
      await js(`__qa.field('Page title','QA Portfolio — Workbench')`)
      await js(`__qa.field('Search description','A clear description of a professional portfolio built and edited in Visual Enigma Editor.')`)
      await js(`__qa.field('Canonical URL','https://example.invalid/portfolio')`)
      await js(`__qa.button('.publish-controls','Save draft')`)
      await waitJs(`!document.querySelector('.save-state')?.classList.contains('dirty')&&!document.querySelector('.desktop-status')?.textContent.includes('Unsaved')`,'builder draft save')
      const project=await js(`veeDesktop.listProjects().then(items=>items.find(item=>item.name==='QA Business Website'))`)
      const saved=await js(`(async()=>({source:JSON.parse((await veeDesktop.readFile(${JSON.stringify(project.id)},'visual-builder/vee.builder.json')).content),html:(await veeDesktop.readFile(${JSON.stringify(project.id)},'visual-builder/preview.html')).content}))()`)
      const first=saved.source.blocks[0]
      if(saved.source.blocks.length!==5||!first.body.includes('**Professional**')||first.backgroundColor!=='#ffe7b3'||first.textAlign!=='right'||first.direction!=='rtl'||saved.source.page.backgroundColor!=='#f5f2e9'||saved.source.seo.title!=='QA Portfolio — Workbench'||!saved.html.includes('<strong>Professional</strong>')||!saved.html.includes('https://example.invalid/portfolio'))throw new Error('Saved builder source or output omitted writing, appearance or SEO fields')
      await waitJs(`document.querySelector('.preview-frame iframe')?.contentDocument?.body?.textContent.includes('Professional writing for the web')`,'rendered portfolio preview')
      const preview=await js(`(()=>{const f=document.querySelector('.preview-frame iframe');const d=f.contentDocument;const h=d.querySelector('h1');const s=d.querySelector('section');const r=h.getBoundingClientRect();return{title:d.title,heading:h.textContent,width:r.width,height:r.height,bodyColor:f.contentWindow.getComputedStyle(d.body).backgroundColor,sectionAlignment:f.contentWindow.getComputedStyle(s).textAlign,sectionDirection:f.contentWindow.getComputedStyle(s).direction,sandbox:f.getAttribute('sandbox')}})()`)
      if(preview.width<20||preview.height<10||preview.title!=='QA Portfolio — Workbench'||preview.sectionAlignment!=='right'||preview.sectionDirection!=='rtl'||preview.sandbox.includes('allow-scripts'))throw new Error('Builder iframe did not visibly render selected styles safely')
      await screenshot('workbench-builder-dark');await appearance('light');await screenshot('workbench-builder-light')
      await js(`__qa.click('#builder-tab-content')`)
      const writingTools=await js(`Array.from(document.querySelectorAll('[aria-label="Writing tools"] button')).map(item=>item.getAttribute('aria-label'))`)
      if(writingTools.length<11||!['Underline','Highlight','Strikethrough','Insert link'].every(label=>writingTools.includes(label)))throw new Error('Expanded writing toolbar missing')
      return{layouts,blockCount:saved.source.blocks.length,firstBlock:first,page:saved.source.page,seo:saved.source.seo,preview,writingTools}
    })
    result.serverPanel=await step('Blank Agent settings and offline guidance',async()=>{
      await js(`__qa.click('[aria-label="Toggle Windows Agent server"]')`)
      await waitJs(`Boolean(document.querySelector('aside[aria-label="Windows Agent server"]'))`,'Windows Agent panel')
      const value=await js(`({host:document.querySelector('aside[aria-label="Windows Agent server"] input')?.value,offline:document.body.innerText.includes('Offline Mode pauses server requests')})`)
      await screenshot('workbench-agent-light')
      if(value.host!==''||!value.offline)throw new Error('Agent host or offline guidance regression')
      return value
    })
    if(result.blockedNetwork.length)throw new Error('A GUI operation attempted a network connection')
    if(result.rendererConsoleErrors.length)throw new Error('Renderer logged a JavaScript or worker error')
    result.success=true;result.step='complete'
  }catch(error){
    result.errors.push(`${result.step}: ${error.stack||error.message}`)
    if(mainWindow&&!mainWindow.isDestroyed()){
      result.failureUI=await js(`({url:location.href,text:document.body.innerText.slice(-18000)})`).catch(()=>null)
      await screenshot('workbench-failure').catch(()=>{})
    }
  }finally{
    await fs.mkdir(outputRoot,{recursive:true});await fs.writeFile(path.join(outputRoot,'desktop-qa.json'),JSON.stringify(result,null,2));app.exit(result.success?0:1)
  }
}).catch(async error=>{
  await fs.mkdir(outputRoot,{recursive:true});await fs.writeFile(path.join(outputRoot,'desktop-qa.json'),JSON.stringify({...result,errors:[error.stack||error.message]},null,2));app.exit(1)
})
