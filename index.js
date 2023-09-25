'use strict';

import os from 'os'
import cp from 'child_process'
import fs from 'fs'
import path from 'path'
import util from 'util'
import zl from 'zip-lib'
import { rimraf, rimrafSync } from 'rimraf'
import { mkdirp } from 'mkdirp'
import { createHash } from 'crypto'
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
  '!**/requirements.in',
  '!**/requirements.txt',
  '!**/requirements_dev.txt',
  '!**/yarn*',
  '!**/.npm*',
  '!**/*.md',
  '!**/*.py(c|o)',
  '!**/README*',
  '!**/LICENSE*',
  '!**/COPYING',
  '!THIRD-PARTY-LICENSES',
  '!include',
  '!networkx/**/tests',
  '!networkx/testing',
  '!pandas/tests',
  '!pandas/_libs/tslibs/src',
  '!pandas/_libs/src',
  '!psutil/tests',
  '!share/doc',
  '!docutils',
  '!numpy/doc',
  '!numpy/**/tests',
  '!numpy/f2py/src',
  '!numpy/core/include/numpy',
  '!scipy/linalg/src',
  '!scipy/optimize/_highs/cython/src',
  '!scipy/**/tests',
  '!scipy/*.rst.txt',
  '!pyarrow/src',
  '!pyarrow/includes',
  '!pyarrow/include',
  '!pyarrow/tests',
  '!pyarrow/*gandiva*',
  '!pyarrow/*plasma*',
  '!scipy.libs/libgfortran-*.0',
  '!scipy.libs/libquadmath-*.0',
  '!scipy.libs/libopenblasp-*.so',
  '!pyarrow/tensorflow/plasma_op.cc',
]

const zip = async (source, out, exclude, log, prefix='') => {
  const z = new zl.Zip({ followSymlinks: true })
  let archive = false
  for await (const file of globbyStream(exclude, {cwd: source, gitignore: true})) {
    if (file.includes('.dist-info/')) continue
    archive = true
    log?.update(`Adding ${file}`)
    z.addFile(path.join(source, file), prefix + file)
  }
  try {
    archive && await z.archive(out)
  } catch (err) { log?.update(`Could not archive ${source}`) }
}

const packageDependencyAsLayer = async (source, outPath, exclude, options, depsLog) => {
  const {requirements, args} = parseRequirements(source, options)
  if (requirements.length === 0) return []
  const name = 'Deps' + createHash('sha1').update(requirements.join('-') + exclude.join('-')).digest('hex')
  const target = path.join(outPath, name)
  if (fs.existsSync(target + '.zip')) return [name]
  depsLog?.update(`Installing ${requirements.length} requirements ...`)
  await Promise.all(requirements.map(async (requirement, i) => {
    depsLog?.update(`Installing ${i}/${requirements.length} ${requirement} ...`)
    await exe(`pip install -q -t ${target} '${requirement}' ${args.join(' ')}`)
    depsLog?.update(`Installed ${i}/${requirements.length} ${requirement}`)
  }))
  const deps = (fs.existsSync(target) ? fs.readdirSync(target) : []).filter(dep => {
    if (!options.requirements.has(dep)) {
      options.requirements.add(dep)
      return true
    }
    rimrafSync(path.join(target, dep))
    return false
  })

  if (deps.length === 0) return []

  depsLog?.update(`Zipping ${name} ...`)
  await zip(target, target + '.zip', exclude, depsLog, 'python/')
  if (!fs.existsSync(target + '.zip')) return []
  depsLog?.update(`Packaged ${name}`)
  rimraf(target).catch(() => depsLog?.update(`Removing ${target} failed.`))
  return [name]
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

const makeSharedModules = async (outPath, slsPath, exclude, options, log) => {
  const shared = Object.entries(options.shared || {})
  const sharedModules = []
  for (const [sharedModule, source] of shared) {
    const moduleName = toPascalCase(sharedModule + 'Shared')
    sharedModules.push(new Promise(async resolve => {
      const out = path.join(outPath, moduleName + '.zip')
      const target = path.join(slsPath, '..', source)
      await zip(target, out, exclude, log, 'python/')
      resolve([moduleName])
    }))
    sharedModules.push(packageDependencyAsLayer(source, outPath, exclude, options, log))
  }
  return (await Promise.all(sharedModules)).flat()
}

const unique = a => a.filter((value, index, array) => array.findIndex(v => v.Ref === value.Ref) === index)

const packageFunction = async (slsFns, name, slsPath, options, serverless, progress, log) => {
  const fn = slsFns[name]
  const module = fn.module || '.'
  const source = path.join(slsPath, '..', module)
  const outPath = path.join(os.tmpdir(), 'slspy')
  const moduleZip = path.join(outPath, toPascalCase('fn-' + module) + '.zip')
  const cached = isCached(slsFns, moduleZip)
  if (cached) return Object.assign(fn, Object.assign({}, cached, fn))

  await mkdirp(outPath)

  const appInfo = progress.get('fn::' + name)
  appInfo?.update('Packaging layers ...')

  const exclude = excludeDefaults.concat(options.exclude || [])
  const sharedModules = await makeSharedModules(outPath, slsPath, exclude, options, appInfo)
  appInfo?.update('Packaging dependencies ...')
  const deps = await packageDependencyAsLayer(source, outPath, exclude, options, appInfo)

  Object.assign(fn, {
    module,
    package: {artifact: moduleZip},
    layers: unique(createLayers(
      deps.concat(sharedModules),
      outPath,
      serverless
    ).concat(fn.layers || []))
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

export default class {
  constructor(serverless, _, { log, progress, writeText }) {
    const options = serverless.service.custom?.pythonRequirements || {}
    if (!Object.keys(options).length) return log.warn('To make this a python project, add "pythonRequirements" inside custom!')
    options.requirements = new Set()
    Object.assign(this, {serverless, options, log, progress, writeText, slsPath: path.join(serverless.config.servicePath, '.serverless')})
    serverless.configSchemaHandler?.defineFunctionProperties?.('aws', {
      properties: {
        module: { type: 'string', },
      }
    })
    this.hooks = {
      'before:package:createDeploymentArtifacts': () => beforePackage(this),
      // 'before:deploy:function:packageFunction': () => beforePackage(this),
      // 'before:offline:start': beforePackage(this),
      // 'before:offline:start:init': beforePackage(this),
    }
  }
}
