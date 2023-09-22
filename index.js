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
  '!**/__pycache__/*',
  '!**/npm-debug.log',
  '!**/package-lock.json',
  '!**/yarn.lock',
  '!**/serverless.yml',
  '!**/package.json',
  '!**/Dockerfile',
  '!**/constraints.txt',
  '!**/requirements.txt',
  '!**/requirements_dev.txt',
  '!**/*.dist-info',
  '!**/yarn*',
  '!**/.npm*',
  '!**/*.md',
  '!**/*.py[c|o]',
  '!**/README*',
  '!**/LICENSE*',
  '!**/COPYING',
  '!python/include',
  '!python/networkx/**/tests',
  '!python/networkx/testing',
  '!python/pandas/tests',
  '!python/pandas/_libs/tslibs/src',
  '!python/pandas/_libs/src',
  '!python/psutil/tests',
  '!python/share/doc',
  '!python/docutils',
  '!python/numpy/doc',
  '!python/numpy/**/tests',
  '!python/numpy/f2py/src',
  '!python/numpy/core/include/numpy',
  '!python/scipy/linalg/src',
  '!python/scipy/optimize/_highs/cython/src',
  '!python/scipy/**/tests',
  '!python/scipy/*.rst.txt',
  '!python/pyarrow/src',
  '!python/pyarrow/includes',
  '!python/pyarrow/include',
  '!python/pyarrow/tests',
  '!python/pyarrow/*gandiva*',
  '!python/pyarrow/*plasma*',
  '!python/scipy.libs/libgfortran-2e0d59d6.so.5.0.0',
  '!python/scipy.libs/libquadmath-2d0c479f.so.0.0.0'
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

const packageDependencyAsLayer = async (source, outPath, exclude, options, depsLog) => {
  const {requirements, args} = parseRequirements(source, options)
  if (requirements.length === 0) return []
  const name = toPascalCase('deps-' + requirements.join('-').slice(0, 1000))
  const target = path.join(outPath, name) // path.join(outPath, toPascalCase(requirement))
  if (fs.existsSync(target + '.zip')) return [name]
  depsLog?.update(`Installing ${requirements.length} requirements ...`)
  await Promise.all(requirements.map(requirement =>
    exe(`pip install -q -t ${path.join(target, 'python')} '${requirement}' ${args.join(' ')}`)
  ))
  depsLog?.update(`Zipping ${name} ...`)
  await zip(target, target + '.zip', exclude, depsLog)
  depsLog?.update(`Cleanup ${name}`)
  try {
    await rimraf(target)
  } catch (err) { depsLog?.update(`Removing ${target} failed.`) }
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

// this does not work when concurrently installing packages
const isCached = (slsFns, moduleZip) => {
  for (const name in slsFns) {
    if (slsFns[name]?.package?.artifact === moduleZip)
      return slsFns[name]
  }
}

const makeSharedModules = async (outPath, slsPath, exclude, options, log) => {
  const shared = Object.entries(options.shared || {})
  const sharedModules = []
  for (const [sharedModule, source] of shared) {
    const moduleName = toPascalCase(sharedModule + 'Shared')
    sharedModules.push(new Promise(async resolve => {
      const out = path.join(outPath, moduleName + '.zip')
      const target = path.join(slsPath, '..', source)
      await zip(target, out, exclude, log)
      resolve([moduleName])
    }))
    sharedModules.push(packageDependencyAsLayer(source, outPath, exclude, options, log))
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

  await mkdirp(outPath)

  const appInfo = progress.get('fn::' + name)
  appInfo?.update('Packaging layers ...')

  const exclude = (options.exclude || []).concat(options.excludeDefaults ? [] : excludeDefaults)
  const sharedModules = await makeSharedModules(outPath, slsPath, exclude, options, appInfo)
  appInfo?.update('Packaging dependencies ...')
  const deps = await packageDependencyAsLayer(source, outPath, exclude, options, appInfo)

  Object.assign(fn, {
    module,
    package: {artifact: moduleZip},
    layers: createLayers(
      deps.concat(sharedModules),
      outPath,
      serverless
    ).concat(fn.layers || [])
  }, options.vpc ? {vpc: options.vpc} : {})

  appInfo?.update('Packaging source ...')
  await zip(source, moduleZip, exclude, appInfo)
  appInfo?.update(`Packaged ${name} ...`)
  appInfo?.remove()
}

const isFunction = (fn, service) =>
  (fn.runtime || service.provider.runtime).match(/^python.*/) && !fn.image

const beforePackage = async ({ serverless, log, progress, slsPath, options }) => {
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

  const appInfo = progress.get(`sls-py::${functions.length}::fns`)

  for (let i = 0; i < functions.length; i++) {
    const name = functions[i]
    appInfo?.update(`Packaging ${i}/${functions.length} ${name}...`)
    try {
      await packageFunction(slsFns, name, slsPath, options, serverless, progress, log)
    } catch (err) { log.error(err) }
  }
  appInfo?.remove()
}

// const afterPackage = async ({ serverless, log }) => {
//   // log.info('Packaged' + JSON.stringify(Object.keys(serverless.service.functions)))
// }

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
      // 'after:package:createDeploymentArtifacts': () => afterPackage(this),
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
