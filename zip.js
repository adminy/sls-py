
const zl = require('zip-lib')
const fs = require('fs')
const path = require('path')

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

module.exports = zip
