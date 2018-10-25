#!/bin/bash
set -ex 
echo 'Installing Serverless'
npm install -g serverless

echo 'building yopass'
GOOS=linux go build -o main

serverless deploy

echo 'Yopass backend deployed!'
echo "Set the backend url when building the website."
echo "REACT_APP_BACKEND_URL=https://yourlambda.execute-api.eu-west-1.amazonaws.com/dev/ yarn build"