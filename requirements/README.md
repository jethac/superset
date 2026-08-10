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

We recommend to everyone in the community to use the pinned requirements in their local development environments, to ensure consistency across different environments, though we don't force requirements as part of our python package semantics to allow flexibility for users to install different versions of the dependencies if they wish.

Note that `development.txt` is a superset of what's in `base.txt`, and all version numbers for shared library should fully match at all times. `translations.txt` is meant as a supplemental file to be used in conjunction with the other requirements files, and is not meant to be used standalone.

## Hashes

Every pin carries a `--hash` for each artifact the resolver considered. A version pin only says which version to request; the hash is what detects a replaced artifact published under that same version. CI and the Docker images install these files with `--require-hashes`, which fails the install if any requirement is unhashed or if a downloaded artifact does not match.

The first-party packages in this repository (`apache-superset`, `apache-superset-core`, `apache-superset-extensions-cli`) are installed as editables from the working tree. An editable has no artifact to hash, and `--require-hashes` rejects any unhashed requirement, so `scripts/uv-pip-compile.sh` excludes them from the generated files with `--no-emit-package`. Their pinned dependencies are still emitted and hashed. Install them alongside the requirements file, as the `Dockerfile` and `.github/actions/setup-backend` do:

```bash
uv pip install --require-hashes -r requirements/development.txt
uv pip install --no-deps -e ./superset-core -e ./superset-extensions-cli
uv pip install -e .
```
