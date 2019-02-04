#!/bin/bash

if [ "$GITHUB_REF" != "refs/heads/master" ]; then
    echo 'Not on master, skipping...'
    exit 0
fi

if git diff-tree --no-commit-id --name-only -r HEAD | \
    grep -E '\.go|aws-lambda'; then
    cd deploy/aws-lambda || (echo 'Failed to cd to deploy/aws-lambda' && exit 1)
    echo 'Building lamba server'
    go build -o main
    echo 'Deploying'
    serverless deploy
else
    echo 'No changes to go files, exiting'
    exit 0
fi

