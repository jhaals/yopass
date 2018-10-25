#!/bin/bash
set -ex

echo "Installing website deps"
(cd ../website; yarn install)

echo "Building website"
(cd ../website; yarn build)

echo "moving website build to app-engine/public"
mv ../website/build ../app-engine/public

echo "running gcloud deploy app"
echo 'Y' | gcloud app deploy