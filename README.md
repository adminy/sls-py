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

package:
  individually: true # TODO: set this in the plugin if the human forgot to set it

functions:
  hello:
    handler: handler.hello
    zip: true
  goodbye:
    handler: handler.goodbye
    zip: true # because we have not specified a module for either lambda, this lambda does not get a say on zip as they share same module
```

### Serverless Python Musts 
- [x] Package a zip based on the specified function defition
	- [x] `module`, `handler`
	- [x] `shared` (however, this is done globally ... to simplify)
- [x] Install requirements.txt for every function
	- [x] ~~allow caching~~ (always cache, just delete .serverless folder for renew)
	- [ ] download caching (downloaded packages cache dir)
- [ ] Time speed in seconds for which each lambda got packaged in
- [x] Allow shared packages for each lambda
- [x] `zip: true` dependencies flag, creates `requirements.zip` (*note* you will have to decompress them in the lambda at startup, add the tmp dir to path)
- [x] filter files that get packaged, including deps into one place called `exclude`
	- [x] ignore serverless [Packaging patterns](https://www.serverless.com/framework/docs/providers/aws/guide/packaging)
	- [x] exclude defaults, a comprehensive list of patterns to exclude from both the module and the requirements
- [ ] custom schema validation module via `input_types` & `output_types`
- [ ] support openapi lambda type via `openapi: true`, false by default, as it creates an extra lambda resource
- [ ] zip deeper deps filtering for pyc and pyo files
- [ ] modularize the code so that all lambda modules can be done in parallel

# Requirements
- [x] minimum required python version >= 3.7
- [x] minimum required node version >= 16


## Known strange behaviour
if two lambdas share the same module code and then
	the first one defined sets `zip: true` for all the rest of the lambdas that share
that same module `zip: true` is set automatically.

Likewise, if the first one defined does not set zip to true, the rest of the lambdas that share
that same module requirements will not be zipped also.
