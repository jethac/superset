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

import json  # noqa: TID251
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from unittest import mock

import pytest

from scripts import supply_chain_scan as scan


def _finding(**overrides: Any) -> scan.Finding:
    defaults: dict[str, Any] = {
        "tool": "osv-scanner",
        "ecosystem": "npm",
        "target": "superset-frontend/package-lock.json",
        "package": "left-pad",
        "version": "1.0.0",
        "identifier": "GHSA-xxxx-yyyy-zzzz",
    }
    defaults.update(overrides)
    return scan.Finding(**defaults)


def test_malware_routing_uses_identifier_prefix() -> None:
    assert _finding(identifier="MAL-2025-3935").is_malware
    assert _finding(aliases=["MAL-2024-1"]).is_malware


def test_malware_routing_uses_malicious_code_cwes() -> None:
    assert _finding(cwes=["CWE-506"]).is_malware
    assert _finding(cwes=["CWE-912"]).is_malware


def test_malware_routing_ignores_advisory_prose() -> None:
    """Advisories about malicious *input* must not fail the run.

    The Babel advisory below is a real finding in this repository's dependency
    tree and is an ordinary code-execution bug, not a hostile package.
    """
    babel = _finding(
        package="@babel/traverse",
        identifier="GHSA-67hx-6x53-jw92",
        title=(
            "Babel vulnerable to arbitrary code execution when compiling "
            "specifically crafted malicious code"
        ),
        cwes=["CWE-184", "CWE-697"],
    )
    assert not babel.is_malware


def test_unfixable_high_severity_advisory_does_not_fail() -> None:
    unfixable = _finding(severity=scan.Severity.HIGH, fixed_versions=[])
    assert not unfixable.has_fix
    assert not unfixable.is_malware


def test_severity_parsing_normalises_vocabularies() -> None:
    assert scan.Severity.parse("MEDIUM") is scan.Severity.MODERATE
    assert scan.Severity.parse("info") is scan.Severity.LOW
    assert scan.Severity.parse(None) is scan.Severity.UNKNOWN
    assert scan.Severity.parse("nonsense") is scan.Severity.UNKNOWN


@pytest.mark.parametrize(
    "score,expected",
    [
        (9.8, scan.Severity.CRITICAL),
        (7.0, scan.Severity.HIGH),
        (5.4, scan.Severity.MODERATE),
        (2.1, scan.Severity.LOW),
    ],
)
def test_cvss_score_maps_to_severity(score: float, expected: scan.Severity) -> None:
    assert scan.Severity.from_cvss_score(score) is expected


def test_parse_osv_output_extracts_fix_and_severity() -> None:
    payload: dict[str, Any] = {
        "results": [
            {
                "source": {"path": "/repo/requirements/base.txt"},
                "packages": [
                    {
                        "package": {
                            "name": "cryptography",
                            "version": "49.0.0",
                            "ecosystem": "PyPI",
                        },
                        "groups": [{"ids": ["PYSEC-2026-3552"], "max_severity": "8.2"}],
                        "vulnerabilities": [
                            {
                                "id": "PYSEC-2026-3552",
                                "aliases": ["CVE-2026-69247"],
                                "summary": "Bleichenbacher oracle",
                                "affected": [
                                    {
                                        "package": {"name": "cryptography"},
                                        "ranges": [
                                            {
                                                "events": [
                                                    {"introduced": "44.0.0"},
                                                    {"fixed": "50.0.0"},
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
    findings = scan.parse_osv_output(payload, "all", Path("/repo"))

    assert len(findings) == 1
    finding = findings[0]
    assert finding.target == "requirements/base.txt"
    assert finding.fixed_versions == ["50.0.0"]
    assert finding.severity is scan.Severity.HIGH
    assert not finding.is_malware


def test_parse_osv_output_flags_malicious_package_feed() -> None:
    payload: dict[str, Any] = {
        "results": [
            {
                "source": {"path": "superset-frontend/package-lock.json"},
                "packages": [
                    {
                        "package": {
                            "name": "evil-pkg",
                            "version": "1.0.0",
                            "ecosystem": "npm",
                        },
                        "vulnerabilities": [
                            {"id": "MAL-2025-3935", "summary": "Malicious code"}
                        ],
                    }
                ],
            }
        ]
    }
    findings = scan.parse_osv_output(payload, "all")

    assert [f.is_malware for f in findings] == [True]


def test_parse_npm_audit_output_reads_cwes_and_fixes() -> None:
    payload: dict[str, Any] = {
        "vulnerabilities": {
            "brace-expansion": {
                "name": "brace-expansion",
                "severity": "high",
                "range": "<1.1.12",
                "fixAvailable": {"name": "brace-expansion", "version": "1.1.12"},
                "via": [
                    {
                        "source": 1130591,
                        "name": "brace-expansion",
                        "title": "brace-expansion: DoS via unbounded expansion",
                        "severity": "high",
                        "cwe": ["CWE-400"],
                        "url": "https://github.com/advisories/GHSA-1",
                    },
                    "minimatch",
                ],
            }
        }
    }
    findings = scan.parse_npm_audit_output(payload, "superset-websocket")

    assert len(findings) == 1
    assert findings[0].identifier == "NPM-1130591"
    assert findings[0].severity is scan.Severity.HIGH
    assert findings[0].fixed_versions == ["1.1.12"]
    assert not findings[0].is_malware


def test_parse_pip_audit_output_reads_fix_versions() -> None:
    payload: dict[str, Any] = {
        "dependencies": [
            {"name": "click", "version": "8.4.2", "vulns": []},
            {
                "name": "flask",
                "version": "2.3.3",
                "vulns": [
                    {
                        "id": "PYSEC-2026-2151",
                        "fix_versions": ["3.1.3"],
                        "aliases": ["CVE-2026-27205"],
                        "description": "Session cookie issue\nmore detail",
                    }
                ],
            },
        ]
    }
    findings = scan.parse_pip_audit_output(payload, "requirements/base.txt")

    assert len(findings) == 1
    assert findings[0].package == "flask"
    assert findings[0].title == "Session cookie issue"
    assert findings[0].fixed_versions == ["3.1.3"]


def test_deduplicate_prefers_the_richest_tool() -> None:
    osv = _finding(tool="osv-scanner", severity=scan.Severity.HIGH)
    npm = _finding(tool="npm-audit", severity=scan.Severity.LOW)
    deduplicated = scan.deduplicate([npm, osv])

    assert len(deduplicated) == 1
    assert deduplicated[0].tool == "osv-scanner"


def _write_lockfile(directory: Path, packages: dict[str, Any]) -> Path:
    lockfile = directory / "package-lock.json"
    lockfile.write_text(json.dumps({"packages": packages}), encoding="utf-8")
    return lockfile


def test_local_packages_are_partitioned_out_of_the_gate(tmp_path: Path) -> None:
    """A squatted name for a workspace package must not fail the run.

    ``eslint-plugin-i18n-strings`` ships from ``eslint-rules/`` in this
    repository, while a hostile package of the same name and version exists on
    the public registry.
    """
    lockfile = _write_lockfile(
        tmp_path,
        {
            "": {"name": "superset"},
            "eslint-rules/eslint-plugin-i18n-strings": {"version": "1.0.0"},
            "node_modules/eslint-plugin-i18n-strings": {
                "resolved": "eslint-rules/eslint-plugin-i18n-strings",
                "link": True,
            },
            "node_modules/left-pad": {
                "version": "1.0.0",
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
            },
        },
    )
    target = scan.Target(
        path=lockfile,
        ecosystem="npm",
        label="package-lock.json",
        kind=scan.LockfileKind.PACKAGE_LOCK,
    )
    local = scan.collect_local_npm_packages([target])

    assert ("eslint-plugin-i18n-strings", "1.0.0") in local
    assert ("left-pad", "1.0.0") not in local

    kept, suppressed = scan.partition_local(
        [
            _finding(package="eslint-plugin-i18n-strings", identifier="MAL-2025-3935"),
            _finding(package="left-pad", identifier="MAL-2025-0001"),
        ],
        local,
    )

    assert [f.package for f in kept] == ["left-pad"]
    assert [f.package for f in suppressed] == ["eslint-plugin-i18n-strings"]


def test_npm_resolved_iteration_skips_links(tmp_path: Path) -> None:
    lockfile = _write_lockfile(
        tmp_path,
        {
            "": {"name": "superset"},
            "node_modules/left-pad": {
                "version": "1.0.0",
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
            },
            "node_modules/workspace-pkg": {"resolved": "packages/thing", "link": True},
        },
    )

    assert list(scan.iter_npm_resolved(lockfile)) == [("left-pad", "1.0.0")]


def test_yarn_resolved_iteration_reads_scoped_and_grouped_entries(
    tmp_path: Path,
) -> None:
    lockfile = tmp_path / "yarn.lock"
    lockfile.write_text(
        "\n".join(
            [
                "# THIS IS AN AUTOGENERATED FILE.",
                "# yarn lockfile v1",
                "",
                '"@scope/pkg@^1.0.0", "@scope/pkg@^1.2.0":',
                '  version "1.2.3"',
                '  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.2.3.tgz"',
                "  dependencies:",
                '    left-pad "^1.0.0"',
                "",
                "left-pad@^1.0.0:",
                '  version "1.0.0"',
                '  resolved "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz"',
                "",
                '"local-thing@file:../local-thing":',
                '  version "0.0.1"',
                '  resolved "file:../local-thing"',
            ]
        ),
        encoding="utf-8",
    )

    assert list(scan.iter_yarn_resolved(lockfile)) == [
        ("@scope/pkg", "1.2.3"),
        ("left-pad", "1.0.0"),
    ]


def test_target_discovery_covers_both_npm_lockfile_formats(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "yarn.lock").write_text("", encoding="utf-8")
    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend" / "package-lock.json").write_text("{}", encoding="utf-8")
    vendored = tmp_path / "frontend" / "node_modules" / "dep"
    vendored.mkdir(parents=True)
    (vendored / "package-lock.json").write_text("{}", encoding="utf-8")
    (tmp_path / "requirements").mkdir()
    (tmp_path / "requirements" / "base.txt").write_text("", encoding="utf-8")

    targets = scan.discover_targets(tmp_path)

    assert [(t.label, t.kind, t.supports_npm_audit) for t in targets] == [
        ("docs/yarn.lock", scan.LockfileKind.YARN_LOCK, False),
        ("frontend/package-lock.json", scan.LockfileKind.PACKAGE_LOCK, True),
        ("requirements/base.txt", scan.LockfileKind.REQUIREMENTS, False),
    ]


def test_pypi_pin_iteration_skips_editable_and_option_lines(tmp_path: Path) -> None:
    requirements = tmp_path / "base.txt"
    requirements.write_text(
        "\n".join(
            [
                "# comment",
                "-e .",
                "--index-url https://example.invalid",
                "flask==2.3.3",
                "    # via -r requirements/base.in",
                "cryptography==49.0.0  # pinned",
                "some-package>=1.0",
            ]
        ),
        encoding="utf-8",
    )

    assert list(scan.iter_pypi_pinned(requirements)) == [
        ("flask", "2.3.3"),
        ("cryptography", "49.0.0"),
    ]


def test_parse_iso8601_normalises_to_utc() -> None:
    parsed = scan.parse_iso8601("2026-08-07T16:32:36.241Z")

    assert parsed is not None
    assert parsed.tzinfo is timezone.utc
    assert scan.parse_iso8601("not a date") is None


def test_npm_publish_time_skips_full_fetch_for_stale_packages() -> None:
    cutoff = datetime(2026, 8, 3, tzinfo=timezone.utc)
    with mock.patch.object(
        scan, "_http_get_json", return_value={"modified": "2026-01-01T00:00:00Z"}
    ) as get:
        assert scan.npm_publish_time("left-pad", "1.0.0", cutoff, 5.0) is None

    assert get.call_count == 1


def test_npm_publish_time_reports_a_release_inside_the_window() -> None:
    cutoff = datetime(2026, 8, 3, tzinfo=timezone.utc)
    responses: list[dict[str, Any]] = [
        {"modified": "2026-08-08T00:00:00Z"},
        {"time": {"1.0.1": "2026-08-08T00:00:00Z"}},
    ]
    with mock.patch.object(scan, "_http_get_json", side_effect=responses):
        published = scan.npm_publish_time("left-pad", "1.0.1", cutoff, 5.0)

    assert published == datetime(2026, 8, 8, tzinfo=timezone.utc)


def test_npm_publish_time_ignores_an_older_resolved_version() -> None:
    cutoff = datetime(2026, 8, 3, tzinfo=timezone.utc)
    responses: list[dict[str, Any]] = [
        {"modified": "2026-08-08T00:00:00Z"},
        {"time": {"1.0.0": "2020-01-01T00:00:00Z"}},
    ]
    with mock.patch.object(scan, "_http_get_json", side_effect=responses):
        assert scan.npm_publish_time("left-pad", "1.0.0", cutoff, 5.0) is None


def test_pypi_publish_time_uses_the_earliest_artefact() -> None:
    cutoff = datetime(2026, 8, 3, tzinfo=timezone.utc)
    document: dict[str, Any] = {
        "urls": [
            {"upload_time_iso_8601": "2026-08-09T12:00:00.000000Z"},
            {"upload_time_iso_8601": "2026-08-08T09:00:00.000000Z"},
        ]
    }
    with mock.patch.object(scan, "_http_get_json", return_value=document):
        published = scan.pypi_publish_time("flask", "3.2.0", cutoff, 5.0)

    assert published == datetime(2026, 8, 8, 9, 0, tzinfo=timezone.utc)


def test_check_cooldown_reports_ages(tmp_path: Path) -> None:
    requirements = tmp_path / "base.txt"
    requirements.write_text("flask==3.2.0\n", encoding="utf-8")
    target = scan.Target(
        path=requirements,
        ecosystem="PyPI",
        label="base.txt",
        kind=scan.LockfileKind.REQUIREMENTS,
    )
    reference = datetime(2026, 8, 10, tzinfo=timezone.utc)
    published = reference - timedelta(days=2)

    def fake_publish_time(
        name: str, version: str, cutoff: datetime, timeout: float
    ) -> Optional[datetime]:
        return published

    with mock.patch.object(scan, "pypi_publish_time", side_effect=fake_publish_time):
        hits = scan.check_cooldown([target], 7, 2, 5.0, now=reference)

    assert len(hits) == 1
    assert hits[0].package == "flask"
    assert hits[0].age_days == pytest.approx(2.0)


def test_digest_reports_findings_without_failing() -> None:
    report = scan.ScanReport(
        targets=[
            scan.Target(
                path=Path("superset-frontend/package-lock.json"),
                ecosystem="npm",
                label="superset-frontend/package-lock.json",
                kind=scan.LockfileKind.PACKAGE_LOCK,
            )
        ],
        findings=[
            _finding(severity=scan.Severity.HIGH, fixed_versions=[]),
            _finding(
                package="brace-expansion",
                identifier="GHSA-aaaa",
                severity=scan.Severity.HIGH,
                fixed_versions=["1.1.12"],
            ),
        ],
        cooldown_hits=[
            scan.CooldownHit(
                ecosystem="npm",
                package="fresh-pkg",
                version="2.0.0",
                published=datetime(2026, 8, 9, tzinfo=timezone.utc),
                age_days=1.0,
            )
        ],
    )
    digest = scan.render_digest(report, 7)

    assert report.malware == []
    assert "No malware-class advisories" in digest
    assert "1 of 2 advisories have no upstream fixed version" in digest
    assert "Releases younger than 7 days" in digest
    assert "fresh-pkg" in digest
