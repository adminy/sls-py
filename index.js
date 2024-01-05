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
  '!pyarrow/tensorflow/plasma_op.cc',
]

const accountToRegionVersions = {
  580247275435: {
    30: ['eu-north-1'],
    31: ['ap-south-1'],
    32: ['ap-northeast-2', 'ca-central-1', 'eu-west-3', 'sa-east-1'],
    33: ['ap-southeast-1', 'ap-southeast-2', 'eu-west-1', 'eu-west-2', 'us-east-2', 'us-west-1', 'us-west-2'],
    35: ['us-east-1', 'eu-central-1'],
    50: ['ap-northeast-1'],
  },
  '012438385374': { 25: ['af-south-1'] },
  519774774795: { 25: ['ap-east-1'] },
  891564319516: { 8: ['ap-south-2'] },
  439286490199: { 11: ['ap-southeast-3'] },
  194566237122: { 2: ['ap-northeast-3'] },
  488211338238: { 26: ['cn-north-1', 'cn-northwest-1'] },
  339249233099: { 25: ['eu-south-1'] },
  352183217350: { 10: ['eu-south-2'] },
  '033019950311': { 7: ['eu-central-2'] },
  285320876703: { 25: ['me-south-1'] },
  732604637566: { 9: ['me-central-1'] }
}
// Note: this is only for x86 architecture, arm is not included here
const getInsightsLayer = region => {
  for (const account in accountToRegionVersions) {
    for (const version in accountToRegionVersions[account]) {
      if (accountToRegionVersions[account][version].includes(region)) {
        return `arn:aws:lambda:${region}:${account}:layer:LambdaInsightsExtension:${version}`
      }
    }
  }

  return 'arn:aws:lambda:us-east-1:580247275435:layer:LambdaInsightsExtension:35'
}

const zips = new Set()

const zip = async (toZip, out, exclude, log) => {
  if (fs.existsSync(out)) return
  const z = new zl.Zip({ followSymlinks: true })
  let archive = false
  for (const source in toZip) {
    const prefix = toZip[source] || ''
    for await (const file of globbyStream(exclude, {cwd: source, gitignore: true})) {
      archive = true
      log?.update(`Adding ${file}`)
      z.addFile(path.join(source, file), prefix + file)
    }
  }
  try {
    archive && await z.archive(out)
  } catch (err) { log?.update(`Could not archive ${Object.keys(toZip)}`) }
}

const packageDependencyAsLayer = async (sources, outPath, exclude, options, depsLog, isShared = false) => {
  const files = []
  for (const source of sources) {
    const {requirements, args} = parseRequirements(source, options)
    if (requirements.length === 0) continue
    files.push({ requirements, args })
  }

  const name = 'Deps' + createHash('sha1').update(
    files.map(({requirements, args}) => requirements.join('-') + '-' + args.join('-')).join('-') 
    + exclude.join('-')
  ).digest('hex')
  const target = path.join(outPath, isShared ? 'SharedDeps' : name)
  const toInstall = []
  for (const {requirements, args} of files) {
    depsLog?.update(`Installing ${requirements.length} requirements ...`)
    toInstall.push(...requirements.map(async (requirement, i) => {
      depsLog?.update(`Installing ${i}/${requirements.length} ${requirement} ...`)
      await exe(`pip install -q -t ${target} '${requirement}' ${args.join(' ')}`)
      depsLog?.update(`Installed ${i}/${requirements.length} ${requirement}`)
    }))
  }
  await Promise.all(toInstall)
  
  const deps = (fs.existsSync(target) ? fs.readdirSync(target) : []).filter(dep => {
      if (options.requirements.has(dep)) {
        rimrafSync(path.join(target, dep))
        return false
      }
      isShared && options.requirements.add(dep)
      return true
  })

  if (deps.length === 0) return []

  depsLog?.update(`Zipping ${target} ...`)    
  await zip({[target]: 'python/'}, target + '.zip', exclude, depsLog)
  depsLog?.update(`Packaged ${name}`)
  rimraf(target).catch(() => depsLog?.update(`Removing ${target} failed.`))
  zips.add(target + '.zip')
  return fs.existsSync(target + '.zip') ? [isShared ? 'SharedDeps' : name] : []
}

const createLayers = (names, outPath, serverless) => names.map(ref => {
  const artifact = path.join(outPath, ref) + '.zip'
  zips.add(artifact)
  serverless.service.layers[ref] = {
    // provide "path" key as a folder to the layer, instead of zip: https://github.com/serverless/serverless/blob/7b1e0120b0c97e811ea32b67a51e4c9e9ccf4edd/lib/plugins/aws/invoke-local/index.js#L341
    package: {
      artifact,
      name: `${serverless.service.service}-${
        serverless.providers.aws.getStage()}-${
          ref.split(/(?=[A-Z])/).join('-').toLowerCase()}`,
      description: `Python packages ${ref}`,
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
  if (shared.length === 0) return []

  const toZip = {}
  for (const [sharedModule, source] of shared) {
    toZip[path.join(slsPath, '..', source)] = `python/${sharedModule}/`
  }

  const out = path.join(outPath, 'Shared.zip')
  await zip(toZip, out, exclude, log)
  zips.add(out)
  const sources = shared.map(([_, source]) => source)
  const sharedDep = await packageDependencyAsLayer(sources, outPath, exclude, options, log, true)
  return ['Shared', ...sharedDep]
}

const unique = a => a.filter((value, index, array) => array.findIndex(v => v.Ref === value.Ref) === index)

const packageFunction = async (slsFns, name, slsPath, outPath, moduleToDep, sharedModules, exclude, options, serverless, progress, log) => {
  const fn = slsFns[name]
  const module = fn.module || '.'
  const source = path.join(slsPath, '..', module)

  const moduleZip = path.join(outPath, toPascalCase('fn-' + module) + '.zip')
  zips.add(moduleZip)
  const cached = isCached(slsFns, moduleZip)
  if (cached) return Object.assign(fn, Object.assign({}, cached, fn))

  const appInfo = progress.get('fn::' + name)
  appInfo?.update('Packaging layers ...')

  const sharedProperties = Object.fromEntries(['vpc', 'timeout'].filter(key => options[key]).map(key => [key, options[key]]))

  Object.assign(fn, {
    module,
    package: {artifact: moduleZip},
    layers: unique(createLayers(
      moduleToDep[module].concat(sharedModules),
      outPath,
      serverless
    ).concat(fn.layers || [])).concat(options.enableLambdaInsights ? [getInsightsLayer(options.region)] : [])
  }, sharedProperties)

  


  appInfo?.update('Packaging source ...')
  await zip({[source]: ''}, moduleZip, exclude, appInfo)
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

  const lambdaInsightsManagedPolicy = 'arn:aws:iam::aws:policy/CloudWatchLambdaInsightsExecutionRolePolicy'
  if (options.enableLambdaInsights) {
    options.region = service.provider.region
    service.provider.iamManagedPolicies = service.provider.iamManagedPolicies || []
    service.provider.iamManagedPolicies.push(lambdaInsightsManagedPolicy)
  }

  const slsFns = service?.functions || {}
  const inputOptions = serverless.processedInput.options
  const functions = (inputOptions.function ? [inputOptions.function] : Object.keys(slsFns))
    .filter(name => isFunction(slsFns[name], service))

  const appInfo = progress.get(`sls-py::${functions.length}::fns`)

  const outPath = path.join(os.tmpdir(), 'slspy')
  const inputExcludes = (options.exclude || []).map(excludePath => '!' + excludePath)
  const exclude = excludeDefaults.concat(inputExcludes)
  await mkdirp(outPath)

  appInfo?.update('Packaging shared layers ...')
  const sharedModules = await makeSharedModules(outPath, slsPath, exclude, options, appInfo)

  appInfo?.update('Packaging dependencies ...')
  const modules = [...new Set(Object.values(slsFns).map(fn => fn.module || '.'))]
  const moduleToDep = Object.fromEntries(await Promise.all(
    modules.map(async module => {
      const source = path.join(slsPath, '..', module)
      return [module, await packageDependencyAsLayer([source], outPath, exclude, options, appInfo)]
    })
  ))
  
  const processLaterModules = []
  const uniqueModules = {}
  for (const name of functions) {
    const module = slsFns[name].module || '.'
    if (uniqueModules[module]) processLaterModules.push(name)
    else uniqueModules[module] = name
  }
  const tasks = [
    Object.values(uniqueModules),
    processLaterModules
  ]
  for (const fns of tasks) {
    await Promise.all(fns.map(async (name, i, a) => {
      try {
        appInfo?.update(`Packaging ${i}/${a.length} ${name}...`)
        await packageFunction(slsFns, name, slsPath, outPath, moduleToDep, sharedModules, exclude, options, serverless, progress, log)
      } catch (err) { log.error(err) }
    }))
  }
  for (const zipFile of fs.readdirSync(outPath)) {
    const target = path.join(outPath, zipFile)
    !zips.has(target) && rimraf(target).catch(() => log?.notice(`Removing ${target} failed.`))
  }
  appInfo?.remove()
}

export default class {
  constructor(serverless, _, { log, progress, writeText }) {
    const options = serverless.service.custom?.pythonRequirements || {}
    if (!Object.keys(options).length) return log.warn('To make this a python project, add "pythonRequirements" inside custom!')
    
    // https://hub.docker.com/r/amazon/aws-lambda-python/tags
    // PYTHONPATH=['/var/task', '/opt/python/lib/python3.9/site-packages', '/opt/python', '/var/runtime', '/var/lang/lib/python39.zip', '/var/lang/lib/python3.9', '/var/lang/lib/python3.9/lib-dynload', '/var/lang/lib/python3.9/site-packages', '/opt/python/lib/python3.9/site-packages', '/opt/python/jaeger_client/thrift_gen', '/opt/python/riskhub/client_py3']
    //serverless.service.provider.environment.LD_LIBRARY_PATH = '/var/lang/lib:/lib64:/usr/lib64:/var/runtime:/var/runtime/lib:/var/task:/var/task/lib:/opt/lib'
    //if (options.zip) serverless.service.provider.environment.PYTHONPATH = '/var/task/vendored:/var/runtime:/var/runtime/_deps.zip'
    
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
