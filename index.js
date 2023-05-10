'use strict';

const fs = require('fs/promises')
const path = require('path')
const util = require('util')
const exe = util.promisify(require('child_process').exec)
const exists = path => fs.access(path).then(() => true).catch(() => false)
// const { stringify } = require('flatted')
const zl = require('zip-lib')

const excludeDefaults = [
  // '**/*.py[c|o]', '**/__pycache__*', '**/*.dist-info*'
  '.git',
  '.gitignore',
  '.serverless',
  '.serverless_plugins',
  '.vscode',
  '.idea',
  '.DS_Store',
  'node_modules',
  '__pycache__',
  '*.dist-info',
  'npm-debug.log',
  'yarn*',
  'package-lock.json',
  'yarn.lock',
  'serverless.yml',
  'package.json'
]

const isInExclude = (file, exclude) => exclude.some(pattern => file.includes(pattern.replaceAll('*', '')))
const elapsedTime = t => process.hrtime(t)[0] * 1000 + parseInt(process.hrtime(t)[1] / 1000000)

const beforePackage = async ({ serverless, log, progress, slsPath, options }) => {
  log.success('before packaging function')
  !await exists(slsPath) && fs.mkdir(slsPath) // DO we really need this?

  const service = serverless.service
  const slsFns = service?.functions || {}
  const exclude = (options.exclude || []).concat(options.excludeDefaults ? [] : excludeDefaults)
  const cachedModules = []
  serverless.zips = {}

  for (const name of Object.keys(slsFns).filter(name => (slsFns[name].runtime || service.provider.runtime).match(/^python.*/) )) {
    const startTime = process.hrtime()

    const fn = slsFns[name]  
    Object.assign(fn, { package: {}, module: fn.module || '.' })
    // skip if already in cache
    if (cachedModules[fn.module]) {
      fn.package.artifact = cachedModules[fn.module]
      continue
    }

    const injectProgress = progress.get('python-inject-requirements')
 
    const zip = new zl.Zip({ followSymlinks: true })
    serverless.zips[fn.module] = zip

    const target = path.join(slsPath, 'functions', fn.module)
    !await exists(target) && await fs.mkdir(target, { recursive: true })
    const source = path.join(process.cwd(), fn.module) // should this be slsPath?

    const sourceCode = new Set()

    for (const file of await fs.readdir(source)) {
      if (isInExclude(file, exclude)) { injectProgress?.update('Skipping', file); continue }
      injectProgress?.update('Copying file', file)
      // await fs.symlink(path.join(source, file), path.join(target, file))
      await fs.cp(path.join(source, file), path.join(target, file), { recursive: true, force: true })
      zip.addFile(path.join(target, file))
      sourceCode.add(file)
    }
    injectProgress?.update('Copying shared modules')

    let sharedR = ''
    for (const [shared, { functions, source }] of Object.entries(options.shared || {})) {
      if (functions.includes(name) && await exists(source)) {
        !await exists(path.join(target, shared)) ? await fs.mkdir(path.join(target, shared)) : log.warning('Dejavu for ', shared)
        for (const file of await fs.readdir(source)) {
          if (isInExclude(file, exclude)) { injectProgress?.update('Skipping', file); continue }
          injectProgress?.update('Copying shared file', file)
          fs.cp(path.join(source, file), path.join(target, shared, file), { recursive: true, force: true })
          zip.addFile(path.join(target, shared, file))
        }
        sharedR += ` -r ${shared}/requirements.txt`
      }
    }

    injectProgress?.update('Installing requirements')
    const cmd = `pip install -r requirements.txt ${sharedR} -t . > /dev/null 2>&1`
    try { await exe(cmd, { cwd: target, env: process.env }) } catch (e) { log.error(e) }

    const depsFiles = []

    for (const file of await fs.readdir(target)) {
      if (isInExclude(file, exclude)) {
        injectProgress?.update('Removing', file)
        await fs.rm(path.join(target, file), { recursive: true, force: true })
      } else !sourceCode.has(file) && depsFiles.push(path.join(target, file))
    }

    if (fn.zip) {
      delete fn.zip
      const depsZip = new zl.Zip({ followSymlinks: true })
      for (const dep of depsFiles) {
        depsZip.addFile(dep)
      }
      const depsZipPath = path.join(target, 'requirements.zip')
      try { await zip.archive(depsZipPath) } catch (err) { log.error(err) }
      zip.addFile(depsZipPath)
    } else {
      for (const dep of depsFiles) {
        zip.addFile(dep)
      }
    }

    const newArtifact = path.join('.serverless', `${(fn.module === '.' ? '' : fn.module + '-') + fn.name}.zip`)
    try { await zip.archive(newArtifact) } catch (err) { log.error(err) }
    delete serverless.zips[name]
    fn.package.artifact = newArtifact
    log.success('Done in:', parseInt(elapsedTime(startTime) / 1000) + ' seconds')
    cachedModules[fn.module] = newArtifact
    injectProgress?.remove()
  }
}

const afterPackage = async ({ log, serverless }) => {
  log.success('after packaging function')
  Object.values(serverless.zips).forEach(zip => zip.cancel())
}

module.exports = class {
  //   let inputOpt = serverless.processedInput.options;
  //   const functions = inputOpt.function && [serverless.service.functions[inputOpt.function]]
  // const architecture = service.provider.architecture || 'x86_64'
  // const dockerImage = `public.ecr.aws/sam/build-${service.provider.runtime}:latest-${architecture}`

  constructor(serverless, _, { log, progress, writeText }) {
    const options = Object.assign({
        excludeDefaults: false,
        // pythonBin: process.platform === 'win32' ? 'python.exe' : service.provider.runtime || 'python',
        useDownloadCache: true,
      },
      (serverless.service.custom?.pythonRequirements) || {}
    )
    Object.assign(this, {serverless, options, log, progress, writeText, slsPath: path.join(serverless.config.servicePath, '.serverless')})
    this.serverless.configSchemaHandler?.defineFunctionProperties?.('aws', {
      properties: {
        module: { type: 'string', },
        zip: { type: 'boolean', default: false },
      }
    })

    this.handleExit(['SIGINT', 'SIGTERM', 'SIGQUIT'])
    this.hooks = {
      'before:package:createDeploymentArtifacts': () => beforePackage(this),
      'after:package:createDeploymentArtifacts': () => afterPackage(this),
      'before:deploy:function:packageFunction': () => beforePackage(this),
      'after:deploy:function:packageFunction': () => afterPackage(this),
    }
  }
  handleExit(signals) {
    for (const signal of signals) {
      process.on(signal, () => this.afterPackage(this))
    }
  }
}