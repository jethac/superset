## Python dependency logic

In this folder, the `.in` files, in conjunction with the `../pyproject.toml` file (in the root of the repo) are used to generate the pinned requirements as `.txt` files.

To alter the pinned dependency, you can edit/alter the `.in` and `pyproject.toml` files, and then run the following command:

```bash
./scripts/uv-pip-compile.sh
```
:::warning
The pinned dependencies are based on the `current` version of python supported in Superset.
Output of `./scripts/uv-pip-compile.sh` may vary slightly based on the python version you are using to run the command.
Check the `pyproject.toml` file for the current version of python supported.
:::

This will generate the pinned requirements in the `.txt` files, which will be used in our CI/CD pipelines and in the Docker images.

## Hash pinning

The `.txt` files are generated with `--generate-hashes`, so every pin carries the
SHA-256 of each artifact it was resolved against, and every install path in CI, in
the Docker images and in the `Makefile` passes `--require-hashes`. A version pin
alone only guarantees that the same *version* is installed; the hash guarantees
that the same *artifact* is installed, so a replaced or re-uploaded artifact for
an already-pinned version fails the install instead of being executed.

`--require-hashes` requires every requirement in a file to be hashed, which local
path dependencies cannot be: `apache-superset`, `apache-superset-core` and
`apache-superset-extensions-cli` resolve from directories in this repository and
have no published artifact. They are excluded from the generated files and
installed explicitly wherever the requirements are installed:

```bash
uv pip install --require-hashes -r requirements/development.txt
uv pip install --no-deps -e ./superset-core -e ./superset-extensions-cli -e .
```

The `--no-deps` matters: without it those installs re-resolve the dependency tree
without hashes, which defeats the point of the hashed file that preceded them.

`duckdb.txt`, `postgres.txt` and `playwright.txt` are supplemental, like
`translations.txt`. `duckdb.txt` and `postgres.txt` pin the corresponding
`pyproject.toml` extras for the Docker image stages that layer a database driver
on top of an image that already has `base.txt` installed; they hold only the
packages `base.txt` does not already provide, so they are installed with
`--no-deps`. `playwright.txt` pins the headless browser tooling that the images
install ahead of `base.txt`, and is therefore standalone rather than a delta.

Two install paths deliberately remain unhashed:

- `uv pip install`'s build isolation downloads build backends (`setuptools`,
  `hatchling`, and similar) for the editable local packages. Those downloads are
  outside the requirements files and cannot be hashed from here.
- `docker/docker-bootstrap.sh` installs `docker/requirements-local.txt`, an
  optional, developer-supplied file in the `docker compose` dev stack. Its
  contents are unknown to this repository, so no hashes can be generated for it.
  The same script also installs the `postgres` extra at container start as a
  backstop for images predating `postgres.txt`; images built from this
  repository already have those pins installed at build time.

We recommend to everyone in the community to use the pinned requirements in their local development environments, to ensure consistency across different environments, though we don't force requirements as part of our python package semantics to allow flexibility for users to install different versions of the dependencies if they wish.

Note that `development.txt` is a superset of what's in `base.txt`, and all version numbers for shared library should fully match at all times. `translations.txt` is meant as a supplemental file to be used in conjunction with the other requirements files, and is not meant to be used standalone.
