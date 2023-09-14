'use strict';

const os = require('os')
const fs = require('fs')
const path = require('path')
const util = require('util')
const exe = util.promisify(require('child_process').exec)
// const exists = path => fs.access(path).then(() => true).catch(() => false)
const zl = require('zip-lib')
const { rimraf } = require('rimraf')
const { mkdirp } = require('mkdirp')

function toPascalCase (str) {
  if (/^[\p{L}\d]+$/iu.test(str)) {
    return str.charAt(0).toUpperCase() + str.slice(1)
  }
  return str.replace(
    /([\p{L}\d])([\p{L}\d]*)/giu,
    (g0, g1, g2) => g1.toUpperCase() + g2 //.toLowerCase()
  ).replace(/[^\p{L}\d]/giu, '')
}

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
  '*.md',
  // Add some of these when we scan beyond the current directory
  // '**/*.py[c|o]', '**/__pycache__*', '**/*.dist-info*', '**/README*', '**/LICENSE*', 'scipy/linalg/src', 'numpy/f2py/src', 'scipy/optimize/_highs/cython/src',
  // - 'networkx/**/tests', 'networkx/testing', 'pandas/tests', 'psutil/tests', 'share/doc', 'docutils/**', 'numpy/*/tests', 'numpy/tests', 'numpy/doc',  
  // - 'scipy/**/tests', 'pyarrow/src', 'pyarrow/includes', 'pyarrow/include', 'pyarrow/tests', 'pyarrow/*gandiva*', 'pyarrow/*plasma*', 'scipy/*.rst.txt'
  // - 'numpy/core/include/numpy', 'scipy.libs/libgfortran-2e0d59d6.so.5.0.0', 'scipy.libs/libquadmath-2d0c479f.so.0.0.0'
]

const isIn = (file, exclude) => exclude.some(pattern => file.includes(pattern.replaceAll('*', '')))

const fileList = dir => fs.readdirSync(dir).reduce((list, file) => {
  const name = path.join(dir, file)
  const isDir = fs.statSync(name).isDirectory()
  return list.concat(isDir ? fileList(name) : [name])
}, [])

const zip = async (source, out, exclude, log) => {
  const z = new zl.Zip({ followSymlinks: true })
  const files = fileList(source)
  for (const file of files) {
    if (isIn(file.slice(source.length), exclude)) {
      log?.update(`Skipping ${file}`)
      continue
    }
    z.addFile(file)
  }
  await z.archive(out)
}


const parseFile = file =>
  fs.readFileSync(file, 'utf-8')
    .replace(/\\\n/g, ' ').split(/\r?\n/)
    .map(line => line.split('#')[0].trim())
    .filter(line => line)
    .reduce((acc, line) => [...acc,
      ...((line.startsWith('-r') || line.startsWith('--requirement')) ?
        parseFile(path.join(path.dirname(file), line.replace(/^--?r\w*\s*=?\s*/, '')))
        : [line])
    ], [])

const parseRequirements = source => {
  const requirementsFile = parseFile(path.join(source, 'requirements.txt'))
  const constraints = []
  const args = new Set()
  const requirements = []
  for (const line of requirementsFile) {
    if (line.startsWith('-i') || line.startsWith('--index-url') || line.startsWith('--extra-index-url') || line.startsWith('--trusted-host')) {
      args.add(line)
      continue
    }
    else if (line.startsWith('-c') || line.startsWith('--constraint')) {
      constraints.push(...parseFile(path.join(source, line.replace(/^--?c\w*\s*=?\s*/, ''))))
      continue
    }
    else if (line.startsWith('-')) continue
    requirements.push(line)
  }
  for (const constraint of constraints) {
    const index = requirements.findIndex(r => r.split(/[>=]+/)[0] == constraint.split(/[>=]+/)[0])
    requirements[index] = constraint
  }
  return { requirements: [...new Set(requirements)], args: [...args] }
}

const packageDependencyAsLayer = async (source, layers, exclude, depsLog) => {
  const {requirements, args} = parseRequirements(source)
  await Promise.all(requirements.map(async requirement => {
    const target = path.join(layers, toPascalCase(requirement))
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
  return requirements.map(requirement => toPascalCase(requirement))
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
  service.package.individually = true
  service.layers = service.layers || {}  

  const slsFns = service?.functions || {}
  const inputOptions = serverless.processedInput.options
  const functions = (inputOptions.function ? [inputOptions.function] : Object.keys(slsFns))
    .filter(name => isFunction(slsFns[name], service))

  return Promise.all(functions.map(name => 
    packageFunction(slsFns, name, slsPath, options, serverless, progress, log)
  )).catch(e => log.error(e))
}

const afterPackage = async ({ serverless, log }) => {}

module.exports = class {
  constructor(serverless, _, { log, progress, writeText }) {
    const options = serverless.service.custom?.pythonRequirements || {}
    Object.assign(this, {serverless, options, log, progress, writeText, slsPath: path.join(serverless.config.servicePath, '.serverless')})
    serverless.configSchemaHandler?.defineFunctionProperties?.('aws', {
      properties: {
        module: { type: 'string', },
    //     zip: { type: 'boolean', default: false },
    //     cmd: { type:'string', default: '' },
    //     pipArgs: { type:'string', default: '' },
    //     exclude: { type: 'array', default: [] },
    //     shared: { type: 'object', default: {} },
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
      process.on(signal, () => process.exit(0, afterPackage(this)))
    }
  }
}