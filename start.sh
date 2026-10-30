#!/bin/sh
cd "$(dirname "$0")"
exec node --disable-warning=ExperimentalWarning --env-file-if-exists=.env server.js
