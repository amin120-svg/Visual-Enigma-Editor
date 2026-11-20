'use strict'

// Explicit portable copy + output directory. No shell; manifest restored exactly.
const fs=require('node:fs/promises')
const path=require('node:path')
const os=require('node:os')
const {spawn}=require('node:child_process')
const {createHash}=require('node:crypto')
async function main(){
  if(!process.argv[2]||!process.argv[3])throw new Error('Specify portable root and QA output directory')
  const portable=path.resolve(process.argv[2]),output=path.resolve(process.argv[3])
  if(output===portable||output.startsWith(portable+path.sep))throw new Error('QA output must be outside portable artifact')
  const appRoot=path.join(portable,'resources','app'),manifest=path.join(appRoot,'package.json'),harness=path.join(appRoot,'qa-harness.cjs'),exe=path.join(portable,'VisualEnigmaEditor.exe')
  await fs.access(exe)
  const original=await fs.readFile(manifest),hash=createHash('sha256').update(original).digest('hex')
  if(await fs.stat(harness).catch(()=>null))throw new Error('Target already contains a QA harness; inspect before testing')
  const data=JSON.parse(original.toString('utf8'))
  if(data.main!=='main.cjs')throw new Error('Production entry must be main.cjs')
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'vee-workbench-qa-'))
  let exitCode,processError,restored=false
  try{
    await fs.mkdir(output,{recursive:true});await fs.copyFile(path.resolve(__dirname,'..','qa-harness.cjs'),harness)
    data.main='qa-harness.cjs';await fs.writeFile(manifest,JSON.stringify(data,null,2)+'\n')
    const env={...process.env,VEE_QA_APP_ROOT:appRoot,VEE_QA_OUTPUT_ROOT:output,VEE_QA_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
    exitCode=await new Promise((resolve,reject)=>{
      const child=spawn(exe,[],{cwd:portable,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
      const log=[];let timedOut=false
      const deadline=setTimeout(()=>{timedOut=true;child.kill()},180_000)
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(log.length<200)log.push(chunk.toString())})
      child.once('error',error=>{clearTimeout(deadline);reject(error)})
      child.once('exit',async code=>{clearTimeout(deadline);await fs.writeFile(path.join(output,'electron-process.log'),log.join(''));if(timedOut)reject(new Error('Packaged QA exceeded 180 seconds; inspect desktop-qa.json and electron-process.log'));else resolve(code)})
    })
  }catch(error){processError=error}
  finally{
    await fs.writeFile(manifest,original);await fs.unlink(harness).catch(error=>{if(error.code!=='ENOENT')throw error})
    restored=(await fs.readFile(manifest)).equals(original)
    if(!restored)throw new Error('Production manifest not restored byte-for-byte')
    // Only this unique mkdtemp profile is removed, never any user workspace.
    await fs.rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:150}).catch(()=>{})
    await fs.writeFile(path.join(output,'entry-restoration.json'),JSON.stringify({restored,sha256:hash,harnessRemoved:!(await fs.stat(harness).catch(()=>null))},null,2))
  }
  if(processError)throw processError
  const report=JSON.parse(await fs.readFile(path.join(output,'desktop-qa.json'),'utf8'))
  if(exitCode!==0||!report.success||report.errors.length||report.rendererConsoleErrors.length)throw new Error(`Packaged QA failed at ${report.step}: ${report.errors.join('; ')||`exit ${exitCode}`}`)
  process.stdout.write(JSON.stringify({success:true,steps:report.steps,report:path.join(output,'desktop-qa.json'),entryRestored:restored})+'\n')
}
main().catch(error=>{process.stderr.write((error.stack||error.message)+'\n');process.exitCode=1})
