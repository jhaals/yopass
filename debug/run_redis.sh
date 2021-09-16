#!/usr/bin/env bash

# docker rm --force $(docker ps --all --quiet);

isRedisRunning=$(docker ps --all | awk '{print $NF}' | grep --word-regexp redis)

if [ ! -z "${isRedisRunning}" ]
then
    docker rm --force redis;
else
    echo "Redis container name does not exist.";
fi

docker run \
    --publish 6379:6379 \
    --name redis \
    library/redis:buster
