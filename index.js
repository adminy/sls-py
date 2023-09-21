'use strict';

import os from 'os'
import cp from 'child_process'
import fs from 'fs'
import path from 'path'
import util from 'util'
import zl from 'zip-lib'
import { rimraf } from 'rimraf'
import { mkdirp } from 'mkdirp'
import { globbyStream } from 'globby'
import parseRequirements from './parse-requirements.js'
import toPascalCase from './pascal-case.js'

const exe = util.promisify(cp.exec)

const excludeDefaults = [
  '**',
  '!**/.git',
  '!**/.gitignore',
  '!**/.serverless',
  '!**/.vscode',
  '!**/.idea',
  '!**/.DS_Store',
  '!**/node_modules',
  '!**/__pycache__',
  '!**/npm-debug.log',
  '!**/package-lock.json',
  '!**/yarn.lock',
  '!**/serverless.yml',
  '!**/package.json',
  '!**/constraints.txt',
  '!**/requirements.txt',
  '!**/requirements_dev.txt',
  '!**/*.dist-info',
  '!**/*.dist-info/*',
  '!**/yarn*',
  '!**/.npm*',
  '!**/*.md',
  '!**/*.py[c|o]',
  '!**/__pycache__*',
  '!**/README*',
  '!**/LICENSE*',
  '!**/scipy/linalg/src',
  '!**/numpy/f2py/src',
  '!**/scipy/optimize/_highs/cython/src',
  '!**/networkx/**/tests',
  '!**/networkx/testing',
  '!**/pandas/tests',
  '!**/psutil/tests',
  '!**/share/doc',
  '!**/docutils/**',
  '!**/numpy/*/tests',
  '!**/numpy/tests',
  '!**/numpy/doc',
  '!**/scipy/**/tests',
  '!**/scipy/*.rst.txt',
  '!**/pyarrow/src',
  '!**/pyarrow/includes',
  '!**/pyarrow/include',
  '!**/pyarrow/tests',
  '!**/pyarrow/*gandiva*',
  '!**/pyarrow/*plasma*',
  '!**/numpy/core/include/numpy',
  '!**/scipy.libs/libgfortran-2e0d59d6.so.5.0.0',
  '!**/scipy.libs/libquadmath-2d0c479f.so.0.0.0'
]

const zip = async (source, out, exclude, log) => {
  const z = new zl.Zip({ followSymlinks: true })
  for await (const file of globbyStream(exclude, {cwd: source, gitignore: true})) {
    log?.update(`Adding ${file}`)
    z.addFile(path.join(source, file), file)
  }
  try {
    await z.archive(out)
  } catch (err) { log?.update(`Could not archive ${source}`) }
}

const packageDependencyAsLayer = async (source, outPath, exclude, indexUrl, depsLog) => {
  const {requirements, args} = parseRequirements(source, indexUrl)
  if (requirements.length === 0) return []
  const name = toPascalCase('deps-' + requirements.join('-').slice(0, 1000))
  const target = path.join(outPath, name) // path.join(outPath, toPascalCase(requirement))
  if (fs.existsSync(target + '.zip')) return
  await Promise.all(requirements.map(async requirement => {
    depsLog?.update(`Installing ${requirement} ...`)
    await exe(`pip install -q -t ${path.join(target, 'python')} '${requirement}' ${args.join(' ')}`)
    depsLog?.update(`Installed ${requirement}! `)
  }))
  depsLog?.update(`Zipping ${name} ...`)
  await zip(target, target + '.zip', exclude, depsLog)
  depsLog?.update(`Cleanup ${name}`)
  try {
    await rimraf(target)
  } catch (err) { depsLog?.update(`Removing ${target}`) }
  depsLog?.update(`Packaged ${name}`)
  depsLog?.remove()
  return [name] //requirements.map(requirement => toPascalCase(requirement))
}

const createLayers = (names, outPath, serverless) => names.map(ref => {
  serverless.service.layers[ref] = {
    package: {
      artifact: path.join(outPath, ref) + '.zip',
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
    if (slsFns[name]?.package?.artifact === moduleZip)
      return slsFns[name]
  }
}

const makeSharedModules = async (fnName, shared, outPath, slsPath, exclude, indexUrl, progress) => {
  const sharedModules = []
  const log = progress.get(`layer::${fnName}::shared`)
  for (const [sharedModule, {source, functions}] of shared) {
    if (!functions.includes(fnName)) continue
    const moduleName = toPascalCase(sharedModule + 'Shared')
    sharedModules.push(new Promise(async resolve => {
      const out = path.join(outPath, moduleName + '.zip')
      const target = path.join(slsPath, '..', source)
      await zip(target, out, exclude, log)
      resolve([moduleName])
    }))
    sharedModules.push(packageDependencyAsLayer(source, outPath, exclude, indexUrl, log))
  }
  return (await Promise.all(sharedModules)).flat()
}

const packageFunction = async (slsFns, name, slsPath, options, serverless, progress, log) => {
  const fn = slsFns[name]
  const module = fn.module || '.'
  const source = path.join(slsPath, '..', module)
  const outPath = path.join(os.tmpdir(), 'slspy') // slsPath
  const moduleZip = path.join(outPath, toPascalCase('fn-' + module) + '.zip')
  const cached = isCached(slsFns, moduleZip)
  if (cached) return Object.assign(fn, Object.assign({}, cached, fn))
  fn.package = {artifact: moduleZip}

  await mkdirp(outPath)
  
  const appInfo = progress.get('fn::' + name)
  appInfo?.update('Packaging layers ...')

  const exclude = (options.exclude || []).concat(options.excludeDefaults ? [] : excludeDefaults)
  const shared = Object.entries(options.shared || {})
  const sharedModules = await makeSharedModules(name, shared, outPath, slsPath, exclude, options.indexUrl, progress)
  appInfo?.update('Packaging dependencies ...')
  const deps = await packageDependencyAsLayer(source, outPath, exclude, options.indexUrl, progress.get(`fn::${name}::deps`))

  Object.assign(fn, {
    module,
    layers: createLayers(
      deps.concat(sharedModules),
      outPath,
      serverless
    ).concat(fn.layers || [])
  }, options.vpn)
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
  service.package.individually = true
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

export default class {
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
      // 'before:deploy:function:packageFunction': () => beforePackage(this),
      // 'after:deploy:function:packageFunction': () => afterPackage(this),
      // 'before:offline:start': beforePackage(this),
      // 'after:offline:start': afterPackage(this),
      // 'before:offline:start:init': beforePackage(this),
      // 'after:offline:start:init': afterPackage(this),
    }
  }
  handleExit(signals) {
    for (const signal of signals) {
      process.on(signal, () => process.exit(0, afterPackage(this)))
    }
  }
}
