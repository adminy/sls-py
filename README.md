# sls-py-pkg
```yaml
plugins:
  - sls-py
custom:
  pythonRequirements:
    indexUrl: https://pypi.org/simple
    shared:
      common_utils:
        source: ../shared
        functions:
          - hello
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
