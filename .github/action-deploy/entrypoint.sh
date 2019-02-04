#!/bin/bash
set -ex
# echo "$GITHUB_REF" | \
#     grep "refs/heads/master" || echo 'Not on master, skipping...' && exit 0

# git diff-tree --no-commit-id --name-only -r HEAD | \
#     grep -E '\.go|aws-lambda' || echo 'No changes to go files, exiting' && exit 0

cd deploy/aws-lambda || (echo 'Failed to cd to deploy/aws-lambda' && exit 1)
echo 'Building lamba server'
go build -o main
echo 'Deploying'
serverless deploy