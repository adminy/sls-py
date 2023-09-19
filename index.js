'use strict';

const os = require('os')
const fs = require('fs')
const path = require('path')
const util = require('util')
const exe = util.promisify(require('child_process').exec)
const zl = require('zip-lib')
const { rimraf } = require('rimraf')
const { mkdirp } = require('mkdirp')
const parseRequirements = require('./parse-requirements')
const zip = require('./zip')
const toPascalCase = require('./pascal-case')

const excludeDefaults = [
  '.git',
  '.gitignore',
  '.serverless',
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
  'requirements.txt',
  'requirements_dev.txt',
  '.npm',
  '*.md'
]

const packageDependencyAsLayer = async (source, layers, exclude, depsLog) => {
  const {requirements, args} = parseRequirements(source)
  const name = toPascalCase(requirements.join('-').slice(0, 200))
  await Promise.all(requirements.map(async requirement => {
    const target = path.join(layers, name) // path.join(layers, toPascalCase(requirement))
    if (fs.existsSync(target + '.zip')) return
    depsLog?.update(`Installing ${requirement}`)
    await exe(`pip install -q -t ${path.join(target, 'python')} '${requirement}' ${args.join(' ')}`)
    depsLog?.update(`Zipping ${requirement}`)
    await zip(target, target + '.zip', exclude, depsLog)
    depsLog?.update(`Cleanup ${requirement}`)
    await rimraf(target)
    depsLog?.update(`Packaged ${requirement}`)
  }))
  depsLog?.remove()
  return [name] //requirements.map(requirement => toPascalCase(requirement))
}

const createLayers = (names, layersPath, serverless) => names.map(ref => {
  serverless.service.layers[ref] = {
    package: {
      artifact: path.join(layersPath, ref) + '.zip',
      name: `${serverless.service.service}-${
        serverless.providers.aws.getStage()}-${
          ref.split(/(?=[A-Z])/).join('-').toLowerCase()}`,
      description: `Python package ${ref}`,
      compatibleRuntimes: [serverless.service.provider.runtime],
    }
  }
  return { Ref: ref + 'LambdaLayer' }
})

const isCached = (slsFns, moduleZip) => {
  for (const name in slsFns) {
    if (slsFns[name]?.package?.artifact === moduleZip) return true
  }
}

const makeSharedModules = async (fnName, shared, layersPath, slsPath, exclude, progress) => {
  const sharedModules = []
  for (const [sharedModule, {source, functions}] of shared) {
    if (!functions.includes(fnName)) continue
    const moduleName = toPascalCase(sharedModule + 'Shared')
    sharedModules.push(new Promise(async resolve => {
      const out = path.join(layersPath, moduleName + '.zip')
      if (!fs.existsSync(out)) {
        const target = path.join(slsPath, '..', source)
        await zl.archiveFolder(target, out, { followSymlinks: true })
      }
      resolve([moduleName])
    }))
    sharedModules.push(packageDependencyAsLayer(source, layersPath, exclude, progress.get(`layer::${fnName}::shared`)))
  }
  return (await Promise.all(sharedModules)).flat()
}

const packageFunction = async (slsFns, name, slsPath, options, serverless, progress, log) => {
  const fn = slsFns[name]
  const module = fn.module || '.'
  const source = path.join(slsPath, '..', module)
  const tmp = path.join(os.tmpdir(), 'slspy') // slsPath
  const layersPath = path.join(tmp, 'layers')
  const functions = path.join(tmp, 'functions')
  const moduleZip = path.join(functions, toPascalCase('fn-' + module) + '.zip')
  if (isCached(slsFns, moduleZip)) return
  fn.package = {artifact: moduleZip}

  await mkdirp(layersPath)
  await mkdirp(functions)
  
  const appInfo = progress.get('fn::' + name)
  appInfo?.update('Packaging layers ...')

  const exclude = (options.exclude || []).concat(options.excludeDefaults ? [] : excludeDefaults)
  const shared = Object.entries(options.shared || {})
  const sharedModules = await makeSharedModules(name, shared, layersPath, slsPath, exclude, progress)
  appInfo?.update('Packaging dependencies ...')
  const deps = await packageDependencyAsLayer(source, layersPath, exclude, progress.get(`fn::${name}::deps`))

  Object.assign(fn, {
    module,
    layers: createLayers(
      deps.concat(sharedModules),
      layersPath,
      serverless
    ).concat(fn.layers || [])
  })
  appInfo?.update('Packaging source ...')
  await zip(source, moduleZip, exclude, appInfo)
  appInfo?.update(`Packaged ${name} ...`)
  appInfo?.remove()
}

const isFunction = (fn, service) =>
  (fn.runtime || service.provider.runtime).match(/^python.*/) && !fn.image

const beforePackage = ({ serverless, log, progress, slsPath, options }) => {
  // set up zips for uploading
  serverless.zips = {}
  const service = serverless.service
  // defaults
  service.package.individually = false
  service.package.excludeDevDependencies = false
  service.layers = service.layers || {}

  const slsFns = service?.functions || {}
  const inputOptions = serverless.processedInput.options
  const functions = (inputOptions.function ? [inputOptions.function] : Object.keys(slsFns))
    .filter(name => isFunction(slsFns[name], service))

  return Promise.all(functions.map(name => 
    packageFunction(slsFns, name, slsPath, options, serverless, progress, log)
  )).catch(e => log.error(e))
}

const afterPackage = async ({ serverless, log }) => {
  // log.info('Packaged' + JSON.stringify(Object.keys(serverless.service.functions)))
}

module.exports = class {
  constructor(serverless, _, { log, progress, writeText }) {
    const options = serverless.service.custom?.pythonRequirements || {}
    if (!Object.keys(options).length) return log.warn('To make this a python project, add "pythonRequirements" inside custom!')
    Object.assign(this, {serverless, options, log, progress, writeText, slsPath: path.join(serverless.config.servicePath, '.serverless')})
    serverless.configSchemaHandler?.defineFunctionProperties?.('aws', {
      properties: {
        module: { type: 'string', },
      }
    })

    this.handleExit(['SIGINT', 'SIGTERM', 'SIGQUIT'])
    this.hooks = {
      'before:package:createDeploymentArtifacts': () => beforePackage(this),
      'after:package:createDeploymentArtifacts': () => afterPackage(this),
      'before:deploy:function:packageFunction': () => beforePackage(this),
      'after:deploy:function:packageFunction': () => afterPackage(this),
      'before:offline:start': beforePackage(this),
      'after:offline:start': afterPackage(this),
      'before:offline:start:init': beforePackage(this),
      'after:offline:start:init': afterPackage(this),

    }
  }
  handleExit(signals) {
    for (const signal of signals) {
      process.on(signal, () => process.exit(0, afterPackage(this)))
    }
  }
}