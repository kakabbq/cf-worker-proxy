#!/usr/bin/env bash

SERVER=$1
if [ "${SERVER}" == "" ]; then
  exit
else
  CONFIG_FILE="./wrangler_${SERVER}.toml"
  if [ -f "${CONFIG_FILE}" ]; then
    npx wrangler deploy -c "${CONFIG_FILE}"
  fi
fi

