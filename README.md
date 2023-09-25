# sls-py-pkg
```yaml
plugins:
  - sls-py
provider:
  name: aws
  runtime: python3.9
  region: eu-west-1
  vpc:
    subnetIds: !Split [",", "subnet-id1,subnet-id2"]
    securityGroupIds: !Split [",", "sg-id1,sg-id2"]
custom:
  pythonRequirements:
    vpc: ${self:provider.vpc}
    indexUrl: https://pypi.org/simple
    extraIndexUrl: https://pypi.org/simple
    trustedHost: pypi.org
    shared:
      common_utils:
        source: ../shared
        functions:
          - hello
    exclude:
      - '!somefile.txt'
      - '!data.tmp'


functions:
  hello:
    handler: handler.hello
```
---
> **Note**


> filter using the `exclude` option.

>In handler.py, **shared** code can be imported like this:
```py
from common_utils import shared_resource
```

<!-- - [ ] [zip-imports](https://docs.python.org/3/library/zipimport.html) -->

## Requirements
---
- [x] python & pip installed
- [x] minimum required node version >= 16

### Features
- `shared` is attached to all the lambdas.
  - you can place repeated dependencies inside your shared layer to:
    - save space.
    - reduce cold startup time.
    - faster deployments.
- `exclude` works for excluding code and dependencies alike.

## TODO improvements
- We're waiting on packages that isn't duplicated work, figure out how to sort all functions in a way that duplicates promise last, everything else is parallel rather than sequential
