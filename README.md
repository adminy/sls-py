# sls-py-pkg
```yaml
plugins:
  - sls-py-pkg
custom:
  pythonRequirements:
    # These options are optional, only set them if you know what you're doing
    # excludeDefaults: false
    # cmd: pip install -r requirements.txt -r common_utils/requirements.txt -t .
    # pipArgs: >
    #   --index-url=https://pypi.org/simple
    #   --secondary-url=https://pypi.org/simple
    shared:
      common_utils:
        source: ../shared
        # if no functions specified, it will apply it to all
        functions:
          - hello
    exclude:
      - pyarrow/src

functions:
  hello:
    module: .
    handler: handler.hello
    zip: true # the handler now has to unzip its own "requirements.zip"
```
---
> **Note**

> Duplicate modules are not supported, for good practices

> filter using the `exclude` options, don't use ~~[Packaging patterns](https://www.serverless.com/framework/docs/providers/aws/guide/packaging)~~

>In handler.py, **shared** code can be imported like this:
```py
from common_utils import shared_resource
```

## Future Features Coming Soon ™️
---
- [ ] custom schema validation module via `input_types` & `output_types`
- [ ] support openapi lambda type via `openapi: true`, false by default, as it creates an extra lambda resource
- [ ] zip deeper deps filtering for pyc and pyo files
## Requirements
---
- [x] python & pip installed
- [x] minimum required node version >= 16
