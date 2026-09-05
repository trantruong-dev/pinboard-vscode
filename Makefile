# Pinboard for VS Code - the commands you actually run while working on the extension.
#
# Thin wrappers over npm, which stays the source of truth: every target runs a script that already
# exists in package.json, so what you run locally and what a release runs cannot drift apart. The
# JetBrains build has the same target names for the same jobs.
#
# Recipes stay free of shell-specific syntax on purpose - see the note on SHELL below.

# Which shell runs the recipes is pinned here rather than left to make.
#
# On Windows, make left to itself picks cmd.exe or a POSIX sh depending on what it finds on PATH -
# not on the shell you typed `make` into, and not consistently between runs on one machine. Asking
# make which shell it holds does not settle it either: it has reported sh while still running the
# recipe through cmd. Naming the shell removes the guess.
#
# Nothing below needs a POSIX shell, which is what makes cmd an acceptable answer here.
ifeq ($(OS),Windows_NT)
  SHELL := cmd.exe
endif

# The version `make release` ships. There is no positional form: make reads a bare 0.0.3 as another
# target to build and fails looking for a rule to make it.
VERSION ?=

.DEFAULT_GOAL := help
.PHONY: help build test watch dist publish release clean

# Written out by hand rather than generated from the target comments, because generating it needs
# grep and awk and this has to print the same under cmd.exe. Keep it in step with the targets.
help:
	@echo Pinboard for VS Code - run make TARGET, where TARGET is one of:
	@echo build - compile TypeScript
	@echo test - compile, then run the suite including a real MCP round trip over HTTP
	@echo watch - recompile on save
	@echo dist - build the installable .vsix
	@echo publish - publish the current version to the VS Code Marketplace
	@echo release - VERSION=0.0.3 ships it: bump, changelog, test, commit, tag, publish, push
	@echo clean - delete build output

build:
	npm run compile

test:
	npm test

watch:
	npm run watch

dist:
	npm run package

# The token is read from the environment by vsce and never passed on the command line, where it
# would end up in the shell history. The guard is a make conditional rather than a shell `test` so
# that it reads the same under cmd.exe, and it checks only that a value is present - nothing here
# ever prints it.
publish:
	@$(if $(VSCE_PAT),,$(error VSCE_PAT is not set - export it before publishing))
	npx vsce publish

# The whole release, from a version number to a published extension:
#
#   make release VERSION=0.0.3
#
# The changelog is generated from the commit messages since the last tag, so write those properly
# rather than editing CHANGELOG.md. commit-and-tag-version bumps package.json, writes the new
# section, commits and tags in one step.
#
# VERSION is passed straight through as --release-as, so the number you ask for is the number that
# ships. Leave it off and `npm run release` picks the next one from the commit types instead.
#
# The commit and tag are made before the upload but pushed after it. An upload that fails then
# leaves a local commit to retry or reset, instead of a tag on the remote announcing a release that
# never reached the Marketplace. If the push is what fails, everything is already published and
# committed - just push again.
release:
	@$(if $(VERSION),,$(error VERSION is not set - run make release VERSION=0.0.3))
	@$(if $(VSCE_PAT),,$(error VSCE_PAT is not set - export it before releasing))
	@echo Releasing $(VERSION). The working tree must be clean and on the branch you release from.
	git diff --quiet HEAD
	npm test
	npx commit-and-tag-version --release-as $(VERSION)
	npm run package
	npx vsce publish --packagePath pinboard-$(VERSION).vsix
	git push --follow-tags origin main

clean:
	npm run clean
