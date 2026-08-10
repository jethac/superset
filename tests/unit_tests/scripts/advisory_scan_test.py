# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from scripts import advisory_scan
from superset.utils import json

MALWARE_NPM_AUDIT: dict[str, Any] = {
    "vulnerabilities": {
        "evil-pkg": {
            "name": "evil-pkg",
            "severity": "critical",
            "range": "*",
            "via": [
                {
                    "source": 1105139,
                    "name": "evil-pkg",
                    "title": "Malware in evil-pkg",
                    "url": "https://github.com/advisories/GHSA-1111-2222-3333",
                    "severity": "critical",
                    "cwe": ["CWE-506"],
                }
            ],
            "fixAvailable": False,
        },
        "left-pad": {
            "name": "left-pad",
            "severity": "high",
            "range": "<1.3.0",
            "via": [
                {
                    "source": 2,
                    "name": "left-pad",
                    "title": "left-pad: ReDoS",
                    "url": "https://github.com/advisories/GHSA-4444-5555-6666",
                    "severity": "high",
                    "cwe": ["CWE-1333"],
                }
            ],
            "fixAvailable": {"name": "left-pad", "version": "1.3.0"},
        },
    }
}

OSV_REPORT: dict[str, Any] = {
    "results": [
        {
            "source": {"path": "superset-websocket/package-lock.json"},
            "packages": [
                {
                    "package": {
                        "name": "brace-expansion",
                        "version": "5.0.7",
                        "ecosystem": "npm",
                    },
                    "vulnerabilities": [
                        {
                            "id": "GHSA-mh99-v99m-4gvg",
                            "aliases": ["CVE-2026-14257"],
                            "summary": "brace-expansion: DoS",
                            "database_specific": {
                                "severity": "HIGH",
                                "cwe_ids": ["CWE-400"],
                            },
                            "affected": [
                                {
                                    "package": {"name": "brace-expansion"},
                                    "ranges": [
                                        {
                                            "events": [
                                                {"introduced": "4.0.0"},
                                                {"fixed": "5.0.8"},
                                            ]
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
        }
    ]
}


def test_npm_audit_malware_is_separated_from_ordinary_advisories() -> None:
    findings = advisory_scan.parse_npm_audit(MALWARE_NPM_AUDIT, "frontend")
    by_package = {f.package: f for f in findings}

    assert by_package["evil-pkg"].is_malware
    assert by_package["evil-pkg"].identifier == "GHSA-1111-2222-3333"
    assert by_package["evil-pkg"].fixed_version is None
    assert not by_package["left-pad"].is_malware
    assert by_package["left-pad"].fixed_version == "1.3.0"


def test_osv_report_yields_severity_and_fixed_version() -> None:
    findings = advisory_scan.parse_osv_scanner(OSV_REPORT, "osv.json")

    assert len(findings) == 1
    assert findings[0].identifier == "GHSA-mh99-v99m-4gvg"
    assert findings[0].severity == "HIGH"
    assert findings[0].fixed_version == "5.0.8"
    assert findings[0].source == "superset-websocket/package-lock.json"
    assert not findings[0].is_malware


def test_pip_audit_malware_detected_from_mal_identifier() -> None:
    document = {
        "dependencies": [
            {
                "name": "evil-dist",
                "version": "1.0.0",
                "vulns": [
                    {
                        "id": "MAL-2026-1234",
                        "description": "Package is malicious.\nSecond line.",
                        "fix_versions": [],
                    }
                ],
            }
        ]
    }
    findings = advisory_scan.parse_pip_audit(document, "requirements/base.txt")

    assert findings[0].is_malware
    assert findings[0].summary == "Package is malicious."


def test_malware_detected_from_alias_when_primary_id_is_a_ghsa() -> None:
    finding = advisory_scan.Finding(
        identifier="GHSA-aaaa-bbbb-cccc",
        package="evil",
        version="1.0.0",
        ecosystem="npm",
        summary="Something happened",
        severity="CRITICAL",
        fixed_version=None,
        source="lock",
        scanner="osv-scanner",
        aliases=("MAL-2026-9999",),
    )

    assert finding.is_malware


def test_ordinary_advisory_mentioning_malware_is_not_malware_class() -> None:
    finding = advisory_scan.Finding(
        identifier="GHSA-aaaa-bbbb-cccc",
        package="scanner-lib",
        version="1.0.0",
        ecosystem="npm",
        summary="Bypass of malware detection in scanner-lib",
        severity="HIGH",
        fixed_version="1.0.1",
        source="lock",
        scanner="osv-scanner",
    )

    assert not finding.is_malware


def _malware_finding(package: str = "evil-pkg") -> advisory_scan.Finding:
    return advisory_scan.Finding(
        identifier="GHSA-1111-2222-3333",
        package=package,
        version="1.0.0",
        ecosystem="npm",
        summary="Malware in " + package,
        severity="CRITICAL",
        fixed_version=None,
        source="lock",
        scanner="npm-audit",
        cwes=("CWE-506",),
    )


def test_triage_fails_only_on_malware() -> None:
    findings = [
        *advisory_scan.parse_npm_audit(MALWARE_NPM_AUDIT, "frontend"),
        *advisory_scan.parse_osv_scanner(OSV_REPORT, "osv.json"),
    ]

    result = advisory_scan.triage(findings, [], date(2026, 8, 10))

    assert [f.package for f in result.malware] == ["evil-pkg"]
    assert sorted(f.package for f in result.other) == ["brace-expansion", "left-pad"]


def test_unexpired_allowlist_entry_suppresses_the_gate() -> None:
    suppression = advisory_scan.Suppression(
        identifier="GHSA-1111-2222-3333",
        package="evil-pkg",
        reason="vendored fork, not installed",
        expires=date(2026, 9, 1),
    )

    result = advisory_scan.triage(
        [_malware_finding()], [suppression], date(2026, 8, 10)
    )

    assert not result.malware
    assert [f.package for f, _ in result.suppressed] == ["evil-pkg"]


def test_expired_allowlist_entry_stops_suppressing() -> None:
    suppression = advisory_scan.Suppression(
        identifier="GHSA-1111-2222-3333",
        package="evil-pkg",
        reason="vendored fork, not installed",
        expires=date(2026, 8, 9),
    )

    result = advisory_scan.triage(
        [_malware_finding()], [suppression], date(2026, 8, 10)
    )

    assert [f.package for f in result.malware] == ["evil-pkg"]
    assert result.expired_suppressions == [suppression]


def test_locally_linked_package_names_do_not_fail_the_gate() -> None:
    lockfile = {
        "packages": {
            "": {"name": "superset"},
            "eslint-rules/eslint-plugin-i18n-strings": {"version": "1.0.0"},
            "node_modules/eslint-plugin-i18n-strings": {
                "resolved": "eslint-rules/eslint-plugin-i18n-strings",
                "link": True,
            },
            "node_modules/left-pad": {
                "version": "1.2.0",
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz",
            },
        }
    }
    local = advisory_scan.local_npm_packages(lockfile)

    assert local == {"eslint-plugin-i18n-strings"}

    result = advisory_scan.triage(
        [_malware_finding("eslint-plugin-i18n-strings"), _malware_finding()],
        [],
        date(2026, 8, 10),
        frozenset(local),
    )

    assert [f.package for f in result.malware] == ["evil-pkg"]
    assert [f.package for f in result.shadowed] == ["eslint-plugin-i18n-strings"]


def test_the_same_report_read_twice_is_reported_once() -> None:
    findings = [
        *advisory_scan.parse_osv_scanner(OSV_REPORT, "osv.json"),
        *advisory_scan.parse_osv_scanner(OSV_REPORT, "osv-copy.json"),
    ]

    assert len(advisory_scan.deduplicate(findings)) == 1


def test_npm_audit_range_is_dropped_when_osv_resolved_the_same_advisory() -> None:
    npm_report = {
        "vulnerabilities": {
            "brace-expansion": {
                "name": "brace-expansion",
                "severity": "high",
                "range": "4.0.0 - 5.0.8",
                "via": [
                    {
                        "source": 1,
                        "name": "brace-expansion",
                        "title": "brace-expansion: DoS",
                        "url": "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
                        "severity": "high",
                        "cwe": ["CWE-400"],
                    }
                ],
                "fixAvailable": True,
            },
            "only-npm-sees-this": {
                "name": "only-npm-sees-this",
                "severity": "low",
                "range": "<1.0.0",
                "via": [
                    {
                        "source": 2,
                        "name": "only-npm-sees-this",
                        "title": "something",
                        "url": "https://github.com/advisories/GHSA-7777-8888-9999",
                        "severity": "low",
                        "cwe": [],
                    }
                ],
                "fixAvailable": True,
            },
        }
    }
    findings = [
        *advisory_scan.parse_osv_scanner(OSV_REPORT, "osv.json"),
        *advisory_scan.parse_npm_audit(npm_report, "npm.json"),
    ]

    kept = advisory_scan.deduplicate(findings)

    assert {(f.package, f.version) for f in kept} == {
        ("brace-expansion", "5.0.7"),
        ("only-npm-sees-this", "<1.0.0"),
    }


def test_allowlist_entry_missing_a_field_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "allowlist.yml"
    path.write_text(
        "suppressions:\n  - id: GHSA-1111-2222-3333\n    package: evil-pkg\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="expires"):
        advisory_scan.load_suppressions(path)


def test_empty_allowlist_and_missing_allowlist_are_both_empty(
    tmp_path: Path,
) -> None:
    empty = tmp_path / "allowlist.yml"
    empty.write_text("suppressions: []\n", encoding="utf-8")

    assert advisory_scan.load_suppressions(empty) == []
    assert advisory_scan.load_suppressions(tmp_path / "absent.yml") == []


def test_digest_reports_how_many_advisories_have_no_fix() -> None:
    findings = [
        *advisory_scan.parse_npm_audit(MALWARE_NPM_AUDIT, "frontend"),
        *advisory_scan.parse_osv_scanner(OSV_REPORT, "osv.json"),
    ]

    digest = advisory_scan.render_digest(
        advisory_scan.triage(findings, [], date(2026, 8, 10))
    )

    assert "### Malware-class advisories: 1 (failing)" in digest
    assert "### Other advisories: 2 (0 with no published fix)" in digest
    assert "`left-pad`" in digest


def test_triage_exits_non_zero_only_for_malware(tmp_path: Path) -> None:
    ordinary = tmp_path / "osv.json"
    ordinary.write_text(json.dumps(OSV_REPORT), encoding="utf-8")
    malicious = tmp_path / "npm.json"
    malicious.write_text(json.dumps(MALWARE_NPM_AUDIT), encoding="utf-8")
    digest = tmp_path / "digest.md"

    assert (
        advisory_scan.main(["triage", "--osv", str(ordinary), "--digest", str(digest)])
        == 0
    )
    assert "Malware-class advisories: none" in digest.read_text(encoding="utf-8")

    assert (
        advisory_scan.main(
            ["triage", "--npm-audit", str(malicious), "--digest", str(digest)]
        )
        == 1
    )


def test_empty_scanner_report_is_not_an_error(tmp_path: Path) -> None:
    empty = tmp_path / "osv.json"
    empty.write_text("", encoding="utf-8")

    assert advisory_scan.main(["triage", "--osv", str(empty)]) == 0


def test_npm_lockfile_versions_are_read_from_both_schemas() -> None:
    v3 = {
        "packages": {
            "": {"name": "root"},
            "node_modules/left-pad": {
                "version": "1.2.0",
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz",
            },
            "node_modules/local-thing": {"resolved": "packages/thing", "link": True},
        }
    }
    v1 = {"dependencies": {"right-pad": {"version": "2.0.0"}}}

    assert advisory_scan.parse_npm_lockfile(v3, "lock") == [
        advisory_scan.ResolvedPackage("npm", "left-pad", "1.2.0", "lock")
    ]
    assert advisory_scan.parse_npm_lockfile(v1, "lock") == [
        advisory_scan.ResolvedPackage("npm", "right-pad", "2.0.0", "lock")
    ]


def test_yarn_lockfile_versions_are_read() -> None:
    text = (
        "# yarn lockfile v1\n"
        "\n"
        '"@11ty/gray-matter@^1.0.0":\n'
        '  version "1.0.0"\n'
        '  resolved "https://registry.yarnpkg.com/@11ty/gray-matter/-/x.tgz"\n'
        "  dependencies:\n"
        '    js-yaml "^4.1.0"\n'
        "\n"
        "left-pad@^1.2.0, left-pad@^1.2.1:\n"
        '  version "1.3.0"\n'
    )

    assert advisory_scan.parse_yarn_lockfile(text, "docs/yarn.lock") == [
        advisory_scan.ResolvedPackage(
            "npm", "@11ty/gray-matter", "1.0.0", "docs/yarn.lock"
        ),
        advisory_scan.ResolvedPackage("npm", "left-pad", "1.3.0", "docs/yarn.lock"),
    ]


def test_only_pinned_requirements_are_dated() -> None:
    text = (
        "# comment\n"
        "-e ./superset-core\n"
        "alembic==1.15.2\n"
        "    # via flask-migrate\n"
        "sqlglot>=28.10.0,<29\n"
        "backports.zoneinfo==0.2.1 ; python_version < '3.9'\n"
    )

    assert advisory_scan.parse_requirements(text, "requirements/base.txt") == [
        advisory_scan.ResolvedPackage(
            "pypi", "alembic", "1.15.2", "requirements/base.txt"
        ),
        advisory_scan.ResolvedPackage(
            "pypi", "backports.zoneinfo", "0.2.1", "requirements/base.txt"
        ),
    ]


def test_freshness_flags_only_versions_inside_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(timezone.utc)
    dates = {
        "fresh": now - timedelta(days=2),
        "old": now - timedelta(days=400),
        "unknown": None,
    }
    monkeypatch.setattr(
        advisory_scan,
        "fetch_published_at",
        lambda package: dates[package.name],
    )
    packages = [
        advisory_scan.ResolvedPackage("npm", name, "1.0.0", "lock") for name in dates
    ]

    report = advisory_scan.find_recent_packages(packages, days=7)

    assert [p.name for p, _ in report.recent] == ["fresh"]
    assert report.scanned == 3
    assert report.undated == 1
    assert (
        "1 of 3 resolved package versions, 1 of which deps.dev could not date"
        in advisory_scan.render_freshness(report, days=7)
    )
