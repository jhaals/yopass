#!/bin/bash

# Start the yopass server 
/yopass-server --database redis --redis ${REDIS_CACHE_URL} --port 80 --force-onetime-secrets --log-level=debug
