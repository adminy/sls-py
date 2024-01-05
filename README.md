# sls-py

![sls-py](https://github.com/adminy/sls-py/assets/22717869/08427ded-a060-4066-958e-98d0a8765726)


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
    # shared properties across all lambda functions
    enableLambdaInsights: true
    vpc: ${self:provider.vpc}
    timeout: 900
    # pip arguments for dependency installation
    indexUrl: https://pypi.org/simple
    extraIndexUrl: https://pypi.org/simple
    trustedHost: pypi.org
    # common modules between all lambda functions
    shared:
      common_utils: ../shared
      common_data: ../data
    # files and directories to exclude
    exclude:
      - somefile.txt
      - data.tmp


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
    - much faster deployments.
- `exclude` works for excluding code and dependencies alike.




License: [lgpl-3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.txt)
