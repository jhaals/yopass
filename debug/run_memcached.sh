#!/usr/bin/env bash

# docker rm --force $(docker ps --all --quiet);

isMemcachedRunning=$(docker ps --all | awk '{print $NF}' | grep --word-regexp memcached)

if [ ! -z "${isMemcachedRunning}" ]
then
    docker rm --force memcached;
else
    echo "Memcached container name does not exist.";
fi

docker run \
    --publish 11211:11211 \
    --name memcached \
    library/memcached:buster \
    --verbose \
    --verbose
