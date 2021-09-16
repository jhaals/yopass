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

expect -f memcached.expect localhost 11211 "${RANDOM_KEY}" "${RANDOM_DATA}"
