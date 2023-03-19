ESBUILD = npx esbuild

build/worker.js: build/.ok node_modules/.ok $(shell find ./src -type f)
	$(ESBUILD) ./src/main.ts --loader:.html=text --outfile=$@ --bundle

build/.ok:
	mkdir -p $(dir $@)
	touch $@

node_modules/.ok: package.json package-lock.json
	npm i
	touch $@
