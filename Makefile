.PHONY: all build test test-verbose coverage check clean help

all: check

help:
	@echo "Targets:"
	@echo "  make build         Build flow.json from src/ via scripts/build.py"
	@echo "  make test          Run the Node.js test suite (list of tests, quiet logs)"
	@echo "  make test-verbose  Run the Node.js test suite with full verbose output"
	@echo "  make coverage      Run tests with coverage thresholds (npm run test:coverage)"
	@echo "  make check         Run build, coverage, and git diff --check"
	@echo "  make clean         Remove local Python cache directories"

build:
	python3 scripts/build.py

test:
	node --test --test-reporter=./scripts/quiet-spec-reporter.mjs tests/*.test.js

test-verbose:
	npm test

coverage:
	npm run test:coverage

check: build coverage
	git diff --check

clean:
	rm -rf __pycache__ scripts/__pycache__ .pytest_cache

