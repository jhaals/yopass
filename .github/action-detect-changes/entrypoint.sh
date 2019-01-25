#!/bin/sh
git diff-tree --no-commit-id --name-only -r HEAD | \
    grep -E '\.go|aws-lambda' || (echo 'No changes to go files, exiting' && exit 1)