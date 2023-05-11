# sls-py-pkg
```yml
plugins:
  - sls-py-pkg
custom:
  pythonRequirements:
    shared:
      common_utils:
        source: ../shared
        functions:
          - hello
    exclude:
      - pyarrow/src

functions:
  hello:
    handler: handler.hello
    zip: true
  goodbye:
    handler: handler.goodbye
    zip: true # the handler now has to unzip its own requirements.zip
```

### Serverless Python Musts 
- [x] Package a zip based on the specified function defition
	- [x] `module`, `handler`
	- [x] `shared` (however, this is done globally ... to simplify)
- [x] Install requirements.txt for every function
	- [x] ~~allow caching~~ (always cache, just delete .serverless folder for renew)
	- [ ] ~~download caching (downloaded packages cache dir)~~
- [x] Allow shared packages for each lambda
- [x] `zip: true` dependencies flag, creates `requirements.zip` (*note* you will have to decompress them in the lambda at startup, add the tmp dir to path)
- [x] filter files that get packaged, including deps into one place called `exclude`
	- [x] ignore serverless [Packaging patterns](https://www.serverless.com/framework/docs/providers/aws/guide/packaging)
	- [x] exclude defaults, a comprehensive list of patterns to exclude from both the module and the requirements
- [ ] custom schema validation module via `input_types` & `output_types`
- [ ] support openapi lambda type via `openapi: true`, false by default, as it creates an extra lambda resource
- [ ] zip deeper deps filtering for pyc and pyo files
- [x] modularize the code so that all lambda modules can be done in parallel ~~(tricky for those sharing the same module)~~
  - [x] Instead, prevent user from doing shared modules, force them to use shared modules instead

# Requirements
- [x] python & pip installed
- [x] minimum required node version >= 16
