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
"""Multi-ecosystem dependency advisory scan with malware-only failure.

Runs ``osv-scanner``, ``npm audit`` and ``pip-audit`` over every lockfile in the
repository, merges the findings, and writes a Markdown digest.

The process exits non-zero only for malware-class advisories (a package that
has been taken over or published with hostile code). Every other advisory, and
every dependency resolved to a release younger than the cooldown window, is
reported in the digest without failing the run (a scanner that fails to run at
all is the one other failure, since that is actionable). Most open advisories
against this set have no upstream fixed version, so a gate that failed on
them would be permanently red and would be muted, which is worse than having no
scheduled scan at all. The rationale, with measurements, is in
``scripts/README-supply-chain-scan.md``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess  # noqa: S404
import sys
import tempfile
from collections.abc import Iterable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

NPM_REGISTRY = "https://registry.npmjs.org"
PYPI_REGISTRY = "https://pypi.org/pypi"
ABBREVIATED_PACKUMENT = "application/vnd.npm.install-v1+json"
USER_AGENT = "superset-supply-chain-scan"

DEFAULT_COOLDOWN_DAYS = 7
DEFAULT_HTTP_TIMEOUT = 30.0
DEFAULT_WORKERS = 16

# CWE-506 (embedded malicious code) and CWE-912 (hidden functionality) are the
# identifiers advisory databases attach to package takeovers and trojanised
# releases. OSV's malicious-package feed prefixes its identifiers with "MAL-".
MALWARE_CWES = frozenset({"CWE-506", "CWE-912"})
MALWARE_ID_PREFIX = "MAL-"

MAX_ACTIONABLE_ROWS = 50

SEVERITY_ORDER = ["critical", "high", "moderate", "low", "unknown"]
# npm and OSV/CVSS disagree on labels; normalise onto the npm vocabulary.
SEVERITY_ALIASES = {"medium": "moderate", "info": "low", "none": "low"}


class Severity(str, Enum):
    """Normalised advisory severity."""

    CRITICAL = "critical"
    HIGH = "high"
    MODERATE = "moderate"
    LOW = "low"
    UNKNOWN = "unknown"

    @classmethod
    def parse(cls, raw: Optional[str]) -> "Severity":
        if not raw:
            return cls.UNKNOWN
        value = SEVERITY_ALIASES.get(raw.strip().lower(), raw.strip().lower())
        try:
            return cls(value)
        except ValueError:
            return cls.UNKNOWN

    @classmethod
    def from_cvss_score(cls, score: float) -> "Severity":
        if score >= 9.0:
            return cls.CRITICAL
        if score >= 7.0:
            return cls.HIGH
        if score >= 4.0:
            return cls.MODERATE
        return cls.LOW


class LockfileKind(str, Enum):
    """The lockfile formats present in this repository."""

    PACKAGE_LOCK = "package-lock"
    YARN_LOCK = "yarn-lock"
    REQUIREMENTS = "requirements"


@dataclass(frozen=True)
class Target:
    """A lockfile to scan, and how each tool should address it."""

    path: Path
    ecosystem: str  # "npm" or "PyPI"
    label: str
    kind: LockfileKind

    @property
    def supports_npm_audit(self) -> bool:
        """``npm audit`` reads npm's own lockfile format and no other."""
        return self.kind is LockfileKind.PACKAGE_LOCK


@dataclass
class Finding:
    """A single advisory against a single resolved package version."""

    tool: str
    ecosystem: str
    target: str
    package: str
    version: str
    identifier: str
    aliases: list[str] = field(default_factory=list)
    severity: Severity = Severity.UNKNOWN
    title: str = ""
    cwes: list[str] = field(default_factory=list)
    fixed_versions: list[str] = field(default_factory=list)
    url: str = ""

    @property
    def has_fix(self) -> bool:
        return bool(self.fixed_versions)

    @property
    def is_malware(self) -> bool:
        """Whether the advisory says the package itself is hostile.

        Malware advisories are the only class this scan fails on, so the test
        is deliberately narrow: an identifier from a malicious-package feed, or
        a malicious-code CWE. Advisory prose is not consulted, because ordinary
        advisories describe malicious *input* in language indistinguishable
        from malicious *packages*.
        """
        identifiers = [self.identifier, *self.aliases]
        if any(i.upper().startswith(MALWARE_ID_PREFIX) for i in identifiers):
            return True
        return any(cwe.upper() in MALWARE_CWES for cwe in self.cwes)

    def key(self) -> tuple[str, str, str, str]:
        return (self.ecosystem, self.package, self.version, self.identifier)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "ecosystem": self.ecosystem,
            "target": self.target,
            "package": self.package,
            "version": self.version,
            "id": self.identifier,
            "aliases": self.aliases,
            "severity": self.severity.value,
            "title": self.title,
            "cwes": self.cwes,
            "fixed_versions": self.fixed_versions,
            "url": self.url,
            "malware": self.is_malware,
        }


@dataclass
class CooldownHit:
    """A dependency resolved to a release younger than the cooldown window."""

    ecosystem: str
    package: str
    version: str
    published: datetime
    age_days: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "ecosystem": self.ecosystem,
            "package": self.package,
            "version": self.version,
            "published": self.published.isoformat(),
            "age_days": round(self.age_days, 2),
        }


@dataclass
class ToolError:
    """A tool that could not be run, or that failed in an unexpected way."""

    tool: str
    target: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"tool": self.tool, "target": self.target, "detail": self.detail}


@dataclass
class ScanReport:
    """Everything a single run produced."""

    findings: list[Finding] = field(default_factory=list)
    suppressed: list[Finding] = field(default_factory=list)
    cooldown_hits: list[CooldownHit] = field(default_factory=list)
    errors: list[ToolError] = field(default_factory=list)
    targets: list[Target] = field(default_factory=list)

    @property
    def malware(self) -> list[Finding]:
        return [f for f in self.findings if f.is_malware]

    def to_dict(self) -> dict[str, Any]:
        return {
            "targets": [t.label for t in self.targets],
            "findings": [f.to_dict() for f in self.findings],
            "suppressed": [f.to_dict() for f in self.suppressed],
            "cooldown_hits": [c.to_dict() for c in self.cooldown_hits],
            "errors": [e.to_dict() for e in self.errors],
        }


def discover_targets(repo_root: Path) -> list[Target]:
    """Finds every lockfile the repository ships, in a stable order."""
    targets: list[Target] = []
    npm_kinds = {
        "package-lock.json": LockfileKind.PACKAGE_LOCK,
        "yarn.lock": LockfileKind.YARN_LOCK,
    }
    for filename, kind in npm_kinds.items():
        for lockfile in sorted(repo_root.glob(f"**/{filename}")):
            if "node_modules" in lockfile.parts:
                continue
            targets.append(
                Target(
                    path=lockfile,
                    ecosystem="npm",
                    label=str(lockfile.relative_to(repo_root)),
                    kind=kind,
                )
            )
    for requirement in sorted((repo_root / "requirements").glob("*.txt")):
        targets.append(
            Target(
                path=requirement,
                ecosystem="PyPI",
                label=str(requirement.relative_to(repo_root)),
                kind=LockfileKind.REQUIREMENTS,
            )
        )
    return sorted(targets, key=lambda target: target.label)


def iter_yarn_resolved(lockfile: Path) -> Iterator[tuple[str, str]]:
    """Yields ``(name, version)`` for every registry package in a yarn v1 lockfile.

    Entries start with one or more unindented descriptors, ``name@range``, and
    carry an indented ``version`` line. The descriptor name is taken from the
    first one, splitting on the last ``@`` so that scoped names survive.
    """
    try:
        lines = lockfile.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    name: Optional[str] = None
    registry_backed = False
    version: Optional[str] = None
    for line in [*lines, ""]:
        if line and not line.startswith((" ", "#")):
            if name and version and registry_backed:
                yield name, version
            descriptor = line.split(",")[0].strip().rstrip(":").strip('"')
            head, _, _ = descriptor.rpartition("@")
            name = head or None
            version = None
            registry_backed = False
            continue
        stripped = line.strip()
        if stripped.startswith("version "):
            version = stripped.split(" ", 1)[1].strip().strip('"')
        elif stripped.startswith("resolved "):
            registry_backed = "registry.yarnpkg.com" in stripped or (
                "registry.npmjs.org" in stripped
            )
    if name and version and registry_backed:
        yield name, version


def iter_npm_local_packages(lockfile: Path) -> Iterator[tuple[str, str]]:
    """Yields ``(name, version)`` for packages resolved from a local path.

    Workspaces and file: dependencies carry a name and version that an attacker
    can squat on the public registry, so advisory databases report hits against
    them even though the code shipped here never comes from the registry.
    """
    try:
        document = json.loads(lockfile.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    for key, entry in document.get("packages", {}).items():
        if not key or entry.get("link"):
            continue
        resolved = str(entry.get("resolved", ""))
        if resolved.startswith(("http://", "https://")):
            continue
        version = entry.get("version")
        name = entry.get("name") or key.rpartition("/")[2]
        if name and version:
            yield str(name), str(version)


def collect_local_npm_packages(targets: Sequence[Target]) -> set[tuple[str, str]]:
    """Collects every locally resolved npm package across all lockfiles."""
    local: set[tuple[str, str]] = set()
    for target in targets:
        if target.kind is LockfileKind.PACKAGE_LOCK:
            local.update(iter_npm_local_packages(target.path))
    return local


def partition_local(
    findings: Sequence[Finding], local: set[tuple[str, str]]
) -> tuple[list[Finding], list[Finding]]:
    """Splits findings into registry-backed ones and locally resolved ones."""
    kept: list[Finding] = []
    suppressed: list[Finding] = []
    for finding in findings:
        if (
            finding.ecosystem.lower() == "npm"
            and (
                finding.package,
                finding.version,
            )
            in local
        ):
            suppressed.append(finding)
        else:
            kept.append(finding)
    return kept, suppressed


def _run(
    command: Sequence[str], cwd: Optional[Path] = None, timeout: int = 1800
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        list(command),
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _load_json(payload: str) -> Any:
    """Parses tool output, tolerating leading progress noise on stdout."""
    stripped = payload.strip()
    if not stripped:
        raise ValueError("empty output")
    start = min(
        (i for i in (stripped.find("{"), stripped.find("[")) if i != -1),
        default=-1,
    )
    if start == -1:
        raise ValueError("no JSON document in output")
    return json.loads(stripped[start:])


def _osv_fixed_versions(vulnerability: dict[str, Any], package: str) -> list[str]:
    fixes: list[str] = []
    for affected in vulnerability.get("affected", []):
        if affected.get("package", {}).get("name") != package:
            continue
        for entry in affected.get("ranges", []):
            for event in entry.get("events", []):
                if "fixed" in event:
                    fixes.append(str(event["fixed"]))
    return sorted(set(fixes))


def _osv_severity(vulnerability: dict[str, Any], group_max: Optional[str]) -> Severity:
    database_specific = vulnerability.get("database_specific", {})
    labelled = database_specific.get("severity")
    if isinstance(labelled, str):
        parsed = Severity.parse(labelled)
        if parsed is not Severity.UNKNOWN:
            return parsed
    if group_max:
        try:
            return Severity.from_cvss_score(float(group_max))
        except ValueError:
            pass
    return Severity.UNKNOWN


def _osv_cwes(vulnerability: dict[str, Any]) -> list[str]:
    database_specific = vulnerability.get("database_specific", {})
    cwes = database_specific.get("cwe_ids", [])
    if isinstance(cwes, list):
        return [str(cwe) for cwe in cwes]
    return []


def parse_osv_output(
    payload: dict[str, Any], target_label: str, repo_root: Optional[Path] = None
) -> list[Finding]:
    """Converts one ``osv-scanner --format=json`` document into findings."""
    findings: list[Finding] = []
    for result in payload.get("results", []):
        source = result.get("source", {}).get("path") or target_label
        if repo_root is not None:
            try:
                source = str(Path(str(source)).relative_to(repo_root))
            except ValueError:
                pass
        for package_result in result.get("packages", []):
            package = package_result.get("package", {})
            name = str(package.get("name", ""))
            version = str(package.get("version", ""))
            ecosystem = str(package.get("ecosystem", ""))
            max_severities = {
                identifier: group.get("max_severity")
                for group in package_result.get("groups", [])
                for identifier in group.get("ids", [])
            }
            for vulnerability in package_result.get("vulnerabilities", []):
                identifier = str(vulnerability.get("id", ""))
                findings.append(
                    Finding(
                        tool="osv-scanner",
                        ecosystem=ecosystem,
                        target=str(source),
                        package=name,
                        version=version,
                        identifier=identifier,
                        aliases=[str(a) for a in vulnerability.get("aliases", [])],
                        severity=_osv_severity(
                            vulnerability, max_severities.get(identifier)
                        ),
                        title=str(vulnerability.get("summary", "")),
                        cwes=_osv_cwes(vulnerability),
                        fixed_versions=_osv_fixed_versions(vulnerability, name),
                        url=f"https://osv.dev/vulnerability/{identifier}",
                    )
                )
    return findings


def parse_npm_audit_output(payload: dict[str, Any], target_label: str) -> list[Finding]:
    """Converts one ``npm audit --json`` document into findings."""
    findings: list[Finding] = []
    vulnerabilities = payload.get("vulnerabilities", {})
    if not isinstance(vulnerabilities, dict):
        return findings
    for name, entry in vulnerabilities.items():
        fix_available = entry.get("fixAvailable")
        for via in entry.get("via", []):
            if not isinstance(via, dict):
                # A string entry means "vulnerable only through that package",
                # which the advisory on the named package already reports.
                continue
            advisory_id = via.get("source")
            fixed: list[str] = []
            if isinstance(fix_available, dict) and fix_available.get("version"):
                fixed = [str(fix_available["version"])]
            elif fix_available is True:
                fixed = ["available"]
            findings.append(
                Finding(
                    tool="npm-audit",
                    ecosystem="npm",
                    target=target_label,
                    package=str(via.get("name", name)),
                    version=str(entry.get("range", "")),
                    identifier=f"NPM-{advisory_id}" if advisory_id else "NPM-unknown",
                    severity=Severity.parse(via.get("severity")),
                    title=str(via.get("title", "")),
                    cwes=[str(cwe) for cwe in via.get("cwe", [])],
                    fixed_versions=fixed,
                    url=str(via.get("url", "")),
                )
            )
    return findings


def parse_pip_audit_output(payload: Any, target_label: str) -> list[Finding]:
    """Converts one ``pip-audit --format=json`` document into findings."""
    findings: list[Finding] = []
    dependencies = (
        payload.get("dependencies", []) if isinstance(payload, dict) else payload
    )
    for dependency in dependencies:
        name = str(dependency.get("name", ""))
        version = str(dependency.get("version", ""))
        for vulnerability in dependency.get("vulns", []):
            identifier = str(vulnerability.get("id", ""))
            findings.append(
                Finding(
                    tool="pip-audit",
                    ecosystem="PyPI",
                    target=target_label,
                    package=name,
                    version=version,
                    identifier=identifier,
                    aliases=[str(a) for a in vulnerability.get("aliases", [])],
                    # pip-audit reports no severity; osv-scanner covers the same
                    # advisories and supplies one where the database has it.
                    severity=Severity.UNKNOWN,
                    title=str(vulnerability.get("description", "")).split("\n")[0],
                    fixed_versions=[
                        str(v) for v in vulnerability.get("fix_versions", [])
                    ],
                    url=f"https://osv.dev/vulnerability/{identifier}",
                )
            )
    return findings


def run_osv_scanner(
    targets: Sequence[Target], repo_root: Path, binary: str, report: ScanReport
) -> None:
    """Runs osv-scanner once over every lockfile."""
    arguments: list[str] = [binary, "scan", "source", "--format=json"]
    for target in targets:
        relative = target.path.relative_to(repo_root)
        if target.kind is LockfileKind.REQUIREMENTS:
            # The requirements files are not named requirements.txt, so the
            # extractor has to be named explicitly.
            arguments.append(f"--lockfile=requirements.txt:{relative}")
        else:
            arguments.append(f"--lockfile={relative}")
    try:
        completed = _run(arguments, cwd=repo_root)
    except (OSError, subprocess.SubprocessError) as error:
        report.errors.append(ToolError("osv-scanner", "all", str(error)))
        return
    # 0: no vulnerabilities, 1: vulnerabilities found. Anything else is a
    # failure of the tool rather than a result.
    if completed.returncode not in (0, 1):
        report.errors.append(
            ToolError("osv-scanner", "all", completed.stderr.strip()[:2000])
        )
        return
    try:
        report.findings.extend(
            parse_osv_output(_load_json(completed.stdout), "all", repo_root)
        )
    except (ValueError, json.JSONDecodeError) as error:
        report.errors.append(ToolError("osv-scanner", "all", str(error)))


def run_npm_audit(target: Target, report: ScanReport) -> None:
    """Runs ``npm audit`` against a single lockfile, without installing."""
    try:
        completed = _run(
            [
                "npm",
                "audit",
                "--json",
                "--package-lock-only",
                "--audit-level=none",
            ],
            cwd=target.path.parent,
        )
    except (OSError, subprocess.SubprocessError) as error:
        report.errors.append(ToolError("npm-audit", target.label, str(error)))
        return
    try:
        payload = _load_json(completed.stdout)
    except (ValueError, json.JSONDecodeError) as error:
        detail = completed.stderr.strip()[:2000] or str(error)
        report.errors.append(ToolError("npm-audit", target.label, detail))
        return
    if isinstance(payload, dict) and payload.get("error"):
        report.errors.append(
            ToolError("npm-audit", target.label, json.dumps(payload["error"])[:2000])
        )
        return
    report.findings.extend(parse_npm_audit_output(payload, target.label))


def run_pip_audit(target: Target, repo_root: Path, report: ScanReport) -> None:
    """Runs ``pip-audit`` against the pinned entries of a requirements file.

    The requirements files also carry editable local projects (``-e .``), which
    pip-audit resolves by building a wheel; that needs the full C toolchain of
    every optional database driver. Only the ``name==version`` pins are audited,
    and the local projects are covered by the source scan instead.
    """
    pins = list(iter_pypi_pinned(target.path))
    if not pins:
        return
    with tempfile.NamedTemporaryFile(
        "w", suffix=".txt", delete=False, encoding="utf-8"
    ) as handle:
        handle.write("\n".join(f"{name}=={version}" for name, version in pins))
        pinned_path = Path(handle.name)
    try:
        completed = _run(
            [
                sys.executable,
                "-m",
                "pip_audit",
                "--requirement",
                str(pinned_path),
                "--no-deps",
                "--format=json",
                "--progress-spinner=off",
            ],
            cwd=repo_root,
        )
    except (OSError, subprocess.SubprocessError) as error:
        report.errors.append(ToolError("pip-audit", target.label, str(error)))
        return
    finally:
        pinned_path.unlink(missing_ok=True)
    try:
        payload = _load_json(completed.stdout)
    except (ValueError, json.JSONDecodeError) as error:
        detail = completed.stderr.strip()[:2000] or str(error)
        report.errors.append(ToolError("pip-audit", target.label, detail))
        return
    report.findings.extend(parse_pip_audit_output(payload, target.label))


def _http_get_json(
    url: str, timeout: float, accept: str = "application/json"
) -> Optional[Any]:
    request = Request(  # noqa: S310
        url, headers={"Accept": accept, "User-Agent": USER_AGENT}
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, ValueError, OSError):
        return None


def parse_iso8601(value: str) -> Optional[datetime]:
    """Parses the ISO-8601 timestamps the npm and PyPI registries return."""
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iter_npm_resolved(lockfile: Path) -> Iterator[tuple[str, str]]:
    """Yields ``(name, version)`` for every registry package in a lockfile."""
    try:
        document = json.loads(lockfile.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    for key, entry in document.get("packages", {}).items():
        if not key or entry.get("link"):
            continue
        resolved = entry.get("resolved", "")
        if not isinstance(resolved, str) or "registry.npmjs.org" not in resolved:
            continue
        version = entry.get("version")
        name = entry.get("name")
        if not name:
            _, _, name = key.rpartition("node_modules/")
        if name and version:
            yield str(name), str(version)


def iter_pypi_pinned(requirements: Path) -> Iterator[tuple[str, str]]:
    """Yields ``(name, version)`` for every ``name==version`` pin."""
    try:
        lines = requirements.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.split("#")[0].strip()
        if not stripped or stripped.startswith("-"):
            continue
        match = re.match(r"^([A-Za-z0-9._-]+)\s*==\s*([^\s;]+)", stripped)
        if match:
            yield match.group(1), match.group(2)


def npm_publish_time(
    name: str, version: str, cutoff: datetime, timeout: float
) -> Optional[datetime]:
    """Returns the publish time of ``version`` if it is newer than ``cutoff``.

    The abbreviated packument carries a single ``modified`` timestamp for the
    whole package, which is a cheap prefilter: a package untouched since the
    cutoff cannot contain a release newer than it. Only packages that pass the
    prefilter cost a full packument fetch.
    """
    quoted = name.replace("/", "%2f")
    abbreviated = _http_get_json(
        f"{NPM_REGISTRY}/{quoted}", timeout, accept=ABBREVIATED_PACKUMENT
    )
    if not isinstance(abbreviated, dict):
        return None
    modified = parse_iso8601(str(abbreviated.get("modified", "")))
    if modified is None or modified < cutoff:
        return None
    full = _http_get_json(f"{NPM_REGISTRY}/{quoted}", timeout)
    if not isinstance(full, dict):
        return None
    published = full.get("time", {}).get(version)
    if not isinstance(published, str):
        return None
    parsed = parse_iso8601(published)
    if parsed is None or parsed < cutoff:
        return None
    return parsed


def pypi_publish_time(
    name: str, version: str, cutoff: datetime, timeout: float
) -> Optional[datetime]:
    """Returns the publish time of ``version`` if it is newer than ``cutoff``."""
    document = _http_get_json(f"{PYPI_REGISTRY}/{name}/{version}/json", timeout)
    if not isinstance(document, dict):
        return None
    stamps = [
        parsed
        for url in document.get("urls", [])
        if (parsed := parse_iso8601(str(url.get("upload_time_iso_8601", ""))))
    ]
    if not stamps:
        return None
    earliest = min(stamps)
    return earliest if earliest >= cutoff else None


def check_cooldown(
    targets: Sequence[Target],
    cooldown_days: int,
    workers: int,
    timeout: float,
    now: Optional[datetime] = None,
) -> list[CooldownHit]:
    """Finds dependencies resolved to a release younger than the window."""
    reference = now or datetime.now(timezone.utc)
    cutoff = reference - timedelta(days=cooldown_days)
    packages: set[tuple[str, str, str]] = set()
    for target in targets:
        if target.kind is LockfileKind.PACKAGE_LOCK:
            resolved = iter_npm_resolved(target.path)
        elif target.kind is LockfileKind.YARN_LOCK:
            resolved = iter_yarn_resolved(target.path)
        else:
            resolved = iter_pypi_pinned(target.path)
        packages.update((target.ecosystem, name, version) for name, version in resolved)

    def resolve(item: tuple[str, str, str]) -> Optional[CooldownHit]:
        ecosystem, name, version = item
        lookup = npm_publish_time if ecosystem == "npm" else pypi_publish_time
        published = lookup(name, version, cutoff, timeout)
        if published is None:
            return None
        return CooldownHit(
            ecosystem=ecosystem,
            package=name,
            version=version,
            published=published,
            age_days=(reference - published).total_seconds() / 86400,
        )

    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = pool.map(resolve, sorted(packages))
    return sorted(
        (hit for hit in results if hit is not None),
        key=lambda hit: hit.age_days,
    )


def deduplicate(findings: Iterable[Finding]) -> list[Finding]:
    """Keeps one finding per package/version/advisory, richest report first."""
    tool_rank = {"osv-scanner": 0, "npm-audit": 1, "pip-audit": 2}
    best: dict[tuple[str, str, str, str], Finding] = {}
    for finding in findings:
        existing = best.get(finding.key())
        if existing is None or tool_rank.get(finding.tool, 9) < tool_rank.get(
            existing.tool, 9
        ):
            best[finding.key()] = finding
    return sorted(
        best.values(),
        key=lambda f: (
            SEVERITY_ORDER.index(f.severity.value),
            f.ecosystem,
            f.package,
            f.identifier,
        ),
    )


def _plural(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def _severity_counts(findings: Sequence[Finding]) -> dict[str, int]:
    counts = dict.fromkeys(SEVERITY_ORDER, 0)
    for finding in findings:
        counts[finding.severity.value] += 1
    return counts


def _table(header: Sequence[str], rows: Iterable[Sequence[str]]) -> list[str]:
    """Renders a Markdown table, or nothing when there are no rows."""
    body = [f"| {' | '.join(row)} |" for row in rows]
    if not body:
        return []
    return [
        f"| {' | '.join(header)} |",
        f"| {' | '.join('---' for _ in header)} |",
        *body,
        "",
    ]


def _malware_section(malware: Sequence[Finding]) -> list[str]:
    if not malware:
        return [
            "## No malware-class advisories",
            "",
            "No dependency matches a malicious-package advisory, so this run "
            "does not fail. Everything below is reported, not gated.",
            "",
        ]
    return [
        f"## :rotating_light: Malware-class advisories: {len(malware)}",
        "",
        *_table(
            ("Package", "Version", "Advisory", "Lockfile"),
            (
                (
                    f"`{f.package}`",
                    f"`{f.version}`",
                    f"[{f.identifier}]({f.url})",
                    f"`{f.target}`",
                )
                for f in malware
            ),
        ),
    ]


def _digest_section(findings: Sequence[Finding], targets: int) -> list[str]:
    counts = _severity_counts(findings)
    unfixable = [f for f in findings if not f.has_fix]
    rows = [
        (
            severity,
            str(counts[severity]),
            str(
                len(
                    [
                        f
                        for f in findings
                        if f.severity.value == severity and not f.has_fix
                    ]
                )
            ),
        )
        for severity in SEVERITY_ORDER
        if counts[severity]
    ]
    return [
        "## Advisory digest",
        "",
        f"{_plural(len(findings), 'advisory', 'advisories')} across "
        f"{_plural(targets, 'lockfile', 'lockfiles')}.",
        "",
        *_table(("Severity", "Count", "Without an upstream fix"), rows),
        f"{len(unfixable)} of {len(findings)} advisories have no upstream fixed "
        "version and cannot be actioned by upgrading.",
        "",
    ]


def _actionable_section(findings: Sequence[Finding]) -> list[str]:
    """Lists the advisories a maintainer can close by upgrading."""
    actionable = [
        f
        for f in findings
        if f.has_fix and f.severity in (Severity.CRITICAL, Severity.HIGH)
    ]
    if not actionable:
        return []
    return [
        "### Fixable, high or critical",
        "",
        *_table(
            ("Package", "Version", "Advisory", "Severity", "Fixed in"),
            (
                (
                    f"`{f.package}`",
                    f"`{f.version}`",
                    f"[{f.identifier}]({f.url})",
                    f.severity.value,
                    ", ".join(f.fixed_versions),
                )
                for f in actionable[:MAX_ACTIONABLE_ROWS]
            ),
        ),
    ]


def _suppressed_section(suppressed: Sequence[Finding]) -> list[str]:
    if not suppressed:
        return []
    return [
        "## Advisories against locally resolved packages",
        "",
        "These package names match a public advisory, but this repository "
        "resolves them from a local path rather than the registry, so the "
        "advisory does not describe the code that ships. They are reported "
        "rather than gated, and each one is a name worth owning on the "
        "public registry.",
        "",
        *_table(
            ("Package", "Version", "Advisory", "Malware-class"),
            (
                (
                    f"`{f.package}`",
                    f"`{f.version}`",
                    f"[{f.identifier}]({f.url})",
                    "yes" if f.is_malware else "no",
                )
                for f in suppressed
            ),
        ),
    ]


def _cooldown_section(hits: Sequence[CooldownHit], cooldown_days: int) -> list[str]:
    lines = [f"## Releases younger than {cooldown_days} days", ""]
    if not hits:
        return [
            *lines,
            "No dependency resolves to a release inside the cooldown window.",
            "",
        ]
    return [
        *lines,
        *_table(
            ("Package", "Version", "Published", "Age (days)"),
            (
                (
                    f"`{hit.package}`",
                    f"`{hit.version}`",
                    hit.published.date().isoformat(),
                    f"{hit.age_days:.1f}",
                )
                for hit in hits
            ),
        ),
    ]


def _errors_section(errors: Sequence[ToolError]) -> list[str]:
    if not errors:
        return []
    return [
        "## Tool errors",
        "",
        *(f"- `{e.tool}` on `{e.target}`: {e.detail}" for e in errors),
        "",
    ]


def render_digest(report: ScanReport, cooldown_days: int) -> str:
    """Renders the Markdown digest posted to the workflow summary."""
    return "\n".join(
        [
            "# Nightly supply-chain scan",
            "",
            *_malware_section(report.malware),
            *_digest_section(report.findings, len(report.targets)),
            *_actionable_section(report.findings),
            *_suppressed_section(report.suppressed),
            *_cooldown_section(report.cooldown_hits, cooldown_days),
            *_errors_section(report.errors),
        ]
    )


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Repository root to scan.",
    )
    parser.add_argument(
        "--osv-scanner-binary",
        default=os.environ.get("OSV_SCANNER_BINARY", "osv-scanner"),
    )
    parser.add_argument(
        "--digest", type=Path, help="Path to write the Markdown digest."
    )
    parser.add_argument("--json", type=Path, help="Path to write the raw findings.")
    parser.add_argument("--cooldown-days", type=int, default=DEFAULT_COOLDOWN_DAYS)
    parser.add_argument("--skip-cooldown", action="store_true")
    parser.add_argument(
        "--allow-tool-errors",
        action="store_true",
        help="Report scanner failures in the digest instead of exiting non-zero.",
    )
    parser.add_argument("--skip-osv-scanner", action="store_true")
    parser.add_argument("--skip-npm-audit", action="store_true")
    parser.add_argument("--skip-pip-audit", action="store_true")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--http-timeout", type=float, default=DEFAULT_HTTP_TIMEOUT)
    return parser.parse_args(argv)


def run_scanners(args: argparse.Namespace, repo_root: Path, report: ScanReport) -> None:
    """Runs every enabled scanner over every discovered target."""
    if not args.skip_osv_scanner:
        run_osv_scanner(report.targets, repo_root, args.osv_scanner_binary, report)
    for target in report.targets:
        if not args.skip_npm_audit and target.supports_npm_audit:
            run_npm_audit(target, report)
        if not args.skip_pip_audit and target.kind is LockfileKind.REQUIREMENTS:
            run_pip_audit(target, repo_root, report)
    if not args.skip_cooldown:
        report.cooldown_hits = check_cooldown(
            report.targets, args.cooldown_days, args.workers, args.http_timeout
        )


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    repo_root: Path = args.repo_root.resolve()
    report = ScanReport(targets=discover_targets(repo_root))
    if not report.targets:
        print(f"No lockfiles found under {repo_root}", file=sys.stderr)
        return 2

    for target in report.targets:
        print(f"target: {target.label} ({target.kind.value})", file=sys.stderr)

    run_scanners(args, repo_root, report)

    report.findings, report.suppressed = partition_local(
        deduplicate(report.findings), collect_local_npm_packages(report.targets)
    )
    digest = render_digest(report, args.cooldown_days)
    if args.digest:
        args.digest.write_text(digest, encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    print(digest)

    if report.malware:
        detail = _plural(len(report.malware), "advisory is", "advisories are")
        print(f"FAIL: {detail} malware-class", file=sys.stderr)
        return 1
    if report.errors and not args.allow_tool_errors:
        # A scanner that did not run is not a clean result. Unlike an advisory
        # with no upstream fix, a broken scanner is something a maintainer can
        # act on, so it is worth failing for.
        detail = _plural(len(report.errors), "scanner", "scanners")
        print(f"FAIL: {detail} failed to run", file=sys.stderr)
        return 2
    reported = _plural(len(report.findings), "advisory", "advisories")
    print(f"PASS: {reported} reported, none malware-class", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
