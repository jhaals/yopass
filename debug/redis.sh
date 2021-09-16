#!/usr/bin/env bash

echo
echo "# Arguments   : ${@}"
echo "# File Path   : ${0}"
echo "# Parent Path : ${0%/*}"
echo "# File Name   : ${0##*/}"
echo "# Base Name   : $(basename ${BASH_SOURCE})"
echo

RANDOM_KEY=$(bash -c "date +%s")
echo "\${RANDOM_KEY}  : ${RANDOM_KEY}"

RANDOM_DATA=$(bash -c "date +%s | sha256sum | base64 | head -c 64; echo")
echo "\${RANDOM_DATA} : ${RANDOM_DATA}"

docker run \
    --network host \
    --rm \
    --interactive \
    --tty library/redis:buster \
    redis-cli \
    set "${RANDOM_KEY}" "${RANDOM_DATA}"

docker run \
    --network host \
    --rm \
    --interactive \
    --tty \
    library/redis:buster \
    redis-cli \
    get "${RANDOM_KEY}"
