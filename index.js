'use strict';

const fs = require('fs/promises')
const path = require('path')
const util = require('util')
const exe = util.promisify(require('child_process').exec)
const exists = path => fs.access(path).then(() => true).catch(() => false)
const zl = require('zip-lib')

const excludeDefaults = [
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
  'package.json',
  // Add some of these when we scan beyond the current directory
  // '**/*.py[c|o]', '**/__pycache__*', '**/*.dist-info*', '**/README*', '**/LICENSE*', 'scipy/linalg/src', 'numpy/f2py/src', 'scipy/optimize/_highs/cython/src',
  // - 'networkx/**/tests', 'networkx/testing', 'pandas/tests', 'psutil/tests', 'share/doc', 'docutils/**', 'numpy/*/tests', 'numpy/tests', 'numpy/doc',  
  // - 'scipy/**/tests', 'pyarrow/src', 'pyarrow/includes', 'pyarrow/include', 'pyarrow/tests', 'pyarrow/*gandiva*', 'pyarrow/*plasma*', 'scipy/*.rst.txt'
  // - 'numpy/core/include/numpy', 'scipy.libs/libgfortran-2e0d59d6.so.5.0.0', 'scipy.libs/libquadmath-2d0c479f.so.0.0.0'
]

const isInExclude = (file, exclude) => exclude.some(pattern => file.includes(pattern.replaceAll('*', '')))

const getCleanDependencies = async (target, sourceCode, exclude, progress) => {
  const depsFiles = []
  for (const file of await fs.readdir(target)) {
    if (isInExclude(file, exclude)) {
      progress?.update('Removing', file)
      await fs.rm(path.join(target, file), { recursive: true, force: true })
    } else !sourceCode.has(file) && depsFiles.push(path.join(target, file))
  }
  return depsFiles
}

const packDepsInZip = async (target, depsFiles) => {
  const depsZip = new zl.Zip({ followSymlinks: true })
  for (const dep of depsFiles) {
    depsZip.addFile(dep)
  }
  const depsZipPath = path.join(target, 'requirements.zip')
  await depsZip.archive(depsZipPath)
  return depsZipPath
}

const getSharedRequirements = async (options, functionName, target, exclude, sourceCode, zip, progress, log) => {
  progress?.update('Copying shared modules')
  let sharedReqs = ''
  for (const [shared, { functions, source }] of Object.entries(options.shared || {})) {
    if (functions.includes(functionName) && await exists(source)) {
      !await exists(path.join(target, shared)) ? await fs.mkdir(path.join(target, shared)) : log.warning('Dejavu for ', shared)
      for (const file of await fs.readdir(source)) {
        if (isInExclude(file, exclude)) { progress?.update('Skipping', file); continue }
        progress?.update('Copying shared file', file)
        const sharedPath = path.join(target, shared, file)
        fs.cp(path.join(source, file), sharedPath, { recursive: true, force: true })
        sourceCode.add(sharedPath)
        zip.addFile(sharedPath)
      }
      sharedReqs += ` -r ${shared}/requirements.txt`
    }
  }
  return sharedReqs
}

const copySources = async (source, target, exclude, zip, progress) => {
  const sourceCode = new Set()
  for (const file of await fs.readdir(source)) {
    if (isInExclude(file, exclude)) {
      progress?.update('Skipping', file)
      continue
    }
    progress?.update('Copying file', file)
    // await fs.symlink(path.join(source, file), path.join(target, file))
    await fs.cp(path.join(source, file), path.join(target, file), { recursive: true, force: true })
    zip.addFile(path.join(target, file))
    sourceCode.add(file)
  }
  return sourceCode
}

const packageFunction = async (slsFns, name, cachedModules, exclude, slsPath, options, serverless, progress, log) => {
  const fn = slsFns[name]  
  Object.assign(fn, { package: {}, module: fn.module || '' })

  if (cachedModules[fn.module]) throw log.error(
    `Module "${fn.module}" already used by function: "${cachedModules[fn.module]}",\n`,
    'Please consider using "shared" option instead.'
  )
  const injectProgress = progress.get('python-inject-requirements-' + name)
  const zip = new zl.Zip({ followSymlinks: true })
  serverless.zips[fn.module] = zip

  const target = path.join(slsPath, 'functions', fn.module)
  !await exists(target) && await fs.mkdir(target, { recursive: true })
  const source = path.join(process.cwd(), fn.module) // should this be slsPath?
  const sourceCode = await copySources(source, target, exclude, zip, injectProgress)
  const sharedReqs = await getSharedRequirements(options, name, target, exclude, sourceCode, zip, injectProgress, log)
  const cmd = options.cmd || `pip install -r requirements.txt ${sharedReqs} -t . ${options.pipArgs.trim()}`
  log.success('Running', cmd)
  await exe(cmd, { cwd: target, env: process.env })

  const depsFiles = await getCleanDependencies(target, sourceCode, exclude, injectProgress)
  const deps = fn.zip ? [await packDepsInZip(target, depsFiles)] : depsFiles
  delete fn.zip
  for (const dep of deps) zip.addFile(dep)

  const newArtifact = path.join('.serverless', `${(fn.module ? fn.module + '-' : '') + fn.name}.zip`)
  await zip.archive(newArtifact)
  delete serverless.zips[fn.module]
  fn.package.artifact = newArtifact
  cachedModules[fn.module] = name
  injectProgress?.remove()
  log.success('Successfully packaged', name)
}

const beforePackage = async ({ serverless, log, progress, slsPath, options }) => {
  const service = serverless.service
  const slsFns = service?.functions || {}
  const exclude = (options.exclude || []).concat(options.excludeDefaults ? [] : excludeDefaults)
  const cachedModules = []
  serverless.zips = {}

  const inputOptions = serverless.processedInput.options
  const functions = inputOptions.function ? [inputOptions.function] : Object.keys(slsFns)

  await Promise.all(
    functions.filter(name => (slsFns[name].runtime || service.provider.runtime).match(/^python.*/) && !slsFns[name].image)
      .map(name => packageFunction(slsFns, name, cachedModules, exclude, slsPath, options, serverless, progress, log))
  )
}

const afterPackage = async ({ serverless, log }) => {
  const zips = Object.values(serverless.zips)
  if (zips.length) {
    zips.forEach(zip => zip.cancel())
    log.error('Failed to package everything ...', 'cancelled')
  } else log.success('Packaged all functions')
  delete serverless.zips
}

module.exports = class {
  constructor(serverless, _, { log, progress, writeText }) {
    serverless.service.package.individually = true
    const options = Object.assign({
        excludeDefaults: false,
        // pythonBin: process.platform === 'win32' ? 'python.exe' : service.provider.runtime || 'python',
        pipArgs: '',
        useDownloadCache: true,
      },
      (serverless.service.custom?.pythonRequirements) || {}
    )
    Object.assign(this, {serverless, options, log, progress, writeText, slsPath: path.join(serverless.config.servicePath, '.serverless')})
    serverless.configSchemaHandler?.defineFunctionProperties?.('aws', {
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