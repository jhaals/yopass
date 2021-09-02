#!/usr/bin/env bash

# https://stelfox.net/blog/2013/11/fail-fast-in-bash-scripts/
function displayError() {
    echo "Error on line ${1} with exit code ${2}."
}

trap 'displayError ${LINENO} $?' ERR

set -o errexit
set -o errtrace
set -o nounset
# set -o xtrace

if [[ "${#}" -eq 0 ]]; then
    echo "No arguments supplied."
    echo "Usage: ${0} \"\$(date +%s | sha256sum | base64 | head -c 64 ; echo)\""
    exit 1
fi

if [[ -z "${1}" ]]
then
    echo "First argument is empty or it is not supplied."
    echo "Usage: ${1} \"Lorem ipsum dolor sit amet, consectetur adipiscing elit.\""
    exit 1
else
    printf "Argument:\t\t%s\n" "${1}"
fi

DECRYPTION_LINK=$(go run \
    ../cmd/yopass \
    --api http://localhost:1337 \
    --url http://localhost:3000 \
    --access-token "${ELVID_ACCESS_TOKEN}" \
    <<<"${1}")
printf "\${DECRYPTION_LINK}:\t%s\n" "${DECRYPTION_LINK}"

DECRYPTED_VALUE=$(go run \
    ../cmd/yopass \
    --api http://localhost:1337 \
    --url http://localhost:3000 \
    --decrypt "${DECRYPTION_LINK}")
printf "\${DECRYPTED_VALUE}:\t%s\n" "${DECRYPTED_VALUE}"
