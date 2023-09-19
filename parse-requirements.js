
const fs = require('fs')
const path = require('path')

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

module.exports = parseRequirements
