#!/bin/sh

echo "$GITHUB_REF" |grep "refs/heads/master" || (echo 'Not on master, skipping...' && exit 1)

git diff-tree --no-commit-id --name-only -r HEAD | \
    grep -E '\.go|aws-lambda' || (echo 'No changes to go files, exiting' && exit 1)