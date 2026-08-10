<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->

# Nightly supply-chain scan

`scripts/supply_chain_scan.py`, run by
`.github/workflows/nightly-supply-chain-scan.yml`, answers one question every
night: **is anything we ship, in any ecosystem, currently known-malicious?**

It runs three scanners over every lockfile in the repository:

| Scanner | Coverage |
| --- | --- |
| `osv-scanner` | every `package-lock.json`, every `yarn.lock`, and all `requirements/*.txt` |
| `npm audit` | each directory containing a `package-lock.json` |
| `pip-audit` | each `requirements/*.txt` |

`npm audit` reads npm's own lockfile format only, so the yarn lockfiles are
covered by `osv-scanner` alone.

The lockfiles are discovered, not listed, so a new workspace lockfile is picked
up without editing the workflow. The twelve found on `master` are
`superset-frontend`, `superset-frontend/cypress-base`, `superset-websocket`,
`superset-websocket/utils/client-ws-app`, `superset-embedded-sdk`, `docs`,
three composite actions under `.github/actions`, and the three `requirements`
files.

## Where the failure line is drawn, and why

The run fails on exactly two things:

1. **A malware-class advisory** against a registry-resolved dependency.
2. **A scanner that failed to run**, which is a broken alarm rather than a clean
   result.

Everything else — every CVE, at every severity, fixed or not — is reported in
the run summary and uploaded as an artefact, and does not fail the job.

That is not a preference; it follows from what the dependency set actually
contains. A run against `master` produced:

```
249 advisories across 12 lockfiles
critical  8    (0 without an upstream fix)
high      134  (7 without an upstream fix)
moderate  86   (1 without an upstream fix)
low       20   (2 without an upstream fix)
unknown   1    (0 without an upstream fix)
```

A gate at `critical` would be red every night for eight advisories that are
mostly transitive dev-tooling issues (`@babel/traverse`, `minimist`,
`json-schema`), none of which a nightly job can resolve on its own. A gate at
`high` would add 134 more. A nightly alarm that is red for reasons nobody can
act on gets muted within a week, and a muted alarm is worse than no alarm: it
manufactures assurance nobody is entitled to.

Malware is different in kind. It is rare, it is unambiguous, and the response is
immediate and obvious: rip the package out. It is the one class where waking
someone up is proportionate.

## What counts as malware

A finding is malware-class if either:

- an identifier or alias comes from a malicious-package feed (OSV's `MAL-`
  namespace), or
- the advisory carries CWE-506 (embedded malicious code) or CWE-912 (hidden
  functionality).

Advisory prose is deliberately **not** consulted. An earlier revision of this
script also matched malware keywords in advisory titles, and it failed the run
on `GHSA-67hx-6x53-jw92`, "Babel vulnerable to arbitrary code execution when
compiling specifically crafted malicious code" — an ordinary code-execution bug
in a package that is not hostile. Advisories describe malicious *input* in
language indistinguishable from malicious *packages*, so the classifier uses
structured fields only. `tests/unit_tests/scripts/supply_chain_scan_test.py`
pins that behaviour.

## Locally resolved packages

Advisories matched against a package that this repository resolves from a local
path rather than the registry are listed separately and never fail the run. The
first run of this scan found one: `MAL-2025-3935`, "Malicious code in
eslint-plugin-i18n-strings", matching
`superset-frontend/eslint-rules/eslint-plugin-i18n-strings@1.0.0`.

The code that ships here is the local ESLint rule, not the registry package, so
failing on it would be wrong. It is worth reading the other way round, though:
someone published a hostile package under the name of a Superset workspace
package. That is a dependency-confusion attempt, and it is reported in the
digest for that reason.

## Release cooldown

The digest also lists any dependency resolved to a release published less than
seven days ago — the signal Dependabot's `cooldown` encodes, and the window in
which most compromised releases are caught and yanked. It is reported, not
gated, because a fresh release is a reason to look, not evidence of a problem.

Publish times come from the registries. For npm, the abbreviated packument's
`modified` timestamp is a cheap prefilter: a package untouched since the cutoff
cannot contain a release newer than it, so only recently modified packages cost
a full packument fetch. For PyPI, the per-version JSON endpoint gives the upload
time directly.

## Running it locally

`pip-audit` requires Python 3.11 or newer; it does not resolve correctly on
3.10. `mysqlclient` publishes no wheel, so its metadata build needs
`pkg-config` and the MySQL client headers, otherwise `pip-audit` fails on
`requirements/development.txt`.

```bash
sudo apt-get install -y pkg-config default-libmysqlclient-dev
pip install pip-audit
curl -sSfL -o /tmp/osv-scanner \
  https://github.com/google/osv-scanner/releases/download/v2.5.0/osv-scanner_linux_amd64
chmod +x /tmp/osv-scanner

python scripts/supply_chain_scan.py \
  --osv-scanner-binary /tmp/osv-scanner \
  --digest /tmp/digest.md \
  --json /tmp/findings.json
```

`--skip-cooldown` drops the registry round-trips, which is most of the runtime.
`--skip-osv-scanner`, `--skip-npm-audit` and `--skip-pip-audit` narrow the run to
one scanner. Exit codes: `0` clean, `1` malware found, `2` a scanner failed.
