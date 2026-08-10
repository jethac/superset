#!/usr/bin/env bash

#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

set -e

# If not already running in Docker, run this script inside Docker
if [ -z "$RUNNING_IN_DOCKER" ]; then
  # Extract "current" Python version from CI config (single source of truth)
  PYTHON_VERSION=$(grep -A 1 'if.*"current"' .github/actions/setup-backend/action.yml | grep 'RESOLVED_VERSION=' | sed 's/.*RESOLVED_VERSION="\([0-9.]*\)".*/\1/')

  if [ -z "$PYTHON_VERSION" ]; then
    echo "Failed to determine Python version from .github/actions/setup-backend/action.yml" >&2
    exit 1
  fi

  echo "Running in Docker (Python ${PYTHON_VERSION} on Linux)..."

  IMAGE="python:${PYTHON_VERSION}-slim"

  # Pre-pull the image with a few retries to absorb transient Docker Hub
  # registry failures ("context deadline exceeded" / anonymous rate-limit blips
  # on shared CI runners). Without this a flaky pull fails the whole
  # check-python-deps job on an infrastructure hiccup rather than a real
  # dependency drift. The pull is in the `until` condition so `set -e` does not
  # abort on an individual failed attempt.
  attempt=1
  max_attempts=4
  until docker pull "$IMAGE"; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "docker pull $IMAGE failed after ${max_attempts} attempts" >&2
      exit 1
    fi
    delay=$((attempt * 10))
    echo "docker pull $IMAGE failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done

  docker run --rm \
    -v "$(pwd)":/app \
    -w /app \
    -e RUNNING_IN_DOCKER=1 \
    "$IMAGE" \
    bash -c "pip install uv && ./scripts/uv-pip-compile.sh $*"

  exit $?
fi

ADDITIONAL_ARGS="$@"

# Pins are emitted with `--hash` entries so that every install can run under
# `--require-hashes`, which pins the artifact and not merely the version.
#
# The repo's own packages are installed from local paths in editable mode, and a
# local path has no artifact to hash. They are therefore left out of the
# generated files entirely (rather than emitted unhashed, which
# `--require-hashes` rejects) and installed explicitly by every install path,
# alongside the hashed requirements file.
COMMON_ARGS=(
  --generate-hashes
  --no-emit-package apache-superset
  --no-emit-package apache-superset-core
  --no-emit-package apache-superset-extensions-cli
)

# Generate the requirements/base.txt file
uv pip compile pyproject.toml requirements/base.in -o requirements/base.txt "${COMMON_ARGS[@]}" $ADDITIONAL_ARGS

# Constraints files cannot carry hashes, so reduce base.txt to bare `name==version` lines
grep --extended-regexp '^[a-zA-Z0-9]' requirements/base.txt | sed 's/ *\\$//' > requirements/base-constraint.txt

# Generate the requirements/development.txt file, making sure the base requirements are used as a constraint to keep the versions in sync. Note that `development.txt` is a Superset of `base.txt` where version for the shared libs should match their version.
uv pip compile requirements/development.in -c requirements/base-constraint.txt -o requirements/development.txt "${COMMON_ARGS[@]}" $ADDITIONAL_ARGS

# NOTE translation is intended as a "supplemental" set of pins that can be combined with either base or dev as needed
uv pip compile requirements/translations.in -o requirements/translations.txt "${COMMON_ARGS[@]}" $ADDITIONAL_ARGS

# The Docker images layer database driver extras and Playwright on top of an
# image that already has base.txt installed. Those installs need pins too, so
# each gets a supplemental file holding only what base.txt does not already
# provide, constrained to the base versions.
# The exclusion list is passed as a uv config file rather than a few hundred
# `--no-emit-package` flags, to keep the command recorded in the generated
# file's header readable and stable across dependency changes.
{
  echo "[pip]"
  echo "no-emit-package = ["
  sed 's/[=<>;[ ].*//' requirements/base-constraint.txt | sed 's/.*/  "&",/'
  echo "]"
} > requirements/base-exclusions.toml

for extra in duckdb postgres; do
  uv --config-file requirements/base-exclusions.toml \
    pip compile "requirements/${extra}.in" -c requirements/base-constraint.txt \
    -o "requirements/${extra}.txt" "${COMMON_ARGS[@]}" $ADDITIONAL_ARGS
done

rm requirements/base-exclusions.toml

# Playwright is installed into the common image layer, before base.txt, so its
# pins are standalone rather than a delta against base.txt.
uv pip compile requirements/playwright.in -o requirements/playwright.txt "${COMMON_ARGS[@]}" $ADDITIONAL_ARGS

# Remove temporary base requirement file
rm requirements/base-constraint.txt
