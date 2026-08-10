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

"""Triage advisory-scanner output across every ecosystem the repo ships.

Two subcommands, both driven by `.github/workflows/nightly-advisory-scan.yml`:

* ``triage`` reads reports produced by ``osv-scanner``, ``npm audit`` and
  ``pip-audit``, deduplicates them, and writes a Markdown digest. It exits
  non-zero for malware-class advisories only. Every other advisory — including
  CRITICAL CVEs — is reported and does not fail the run.
* ``freshness`` reads lockfiles and flags dependencies resolved to a version
  published within the last N days, the signal Dependabot's ``cooldown``
  setting encodes.

The malware-only gate is deliberate. A gate that fails on every open advisory
without an upstream fix is red for reasons no one in the repo can act on, and a
permanently red scheduled job is muted rather than read. Malware-class
advisories are different in kind: the remedy is always to remove the package,
and it is always urgent.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import sys
import urllib.parse
import urllib.request
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

import yaml

# GitHub, OSV and PyPI all express "this package is malware" the same three
# ways. Any one of them is enough to trip the gate.
MALWARE_CWES: frozenset[str] = frozenset({"CWE-506"})
MALWARE_ID_PREFIX: str = "MAL-"
MALWARE_SUMMARY_RE: re.Pattern[str] = re.compile(
    r"^(malware|malicious code)\b", re.IGNORECASE
)

DEPS_DEV_URL: str = (
    "https://api.deps.dev/v3/systems/{system}/packages/{name}/versions/{version}"  # noqa: E501
)
DEPS_DEV_TIMEOUT_SECONDS: int = 30
DEPS_DEV_WORKERS: int = 16

# yarn v1 lockfile entries are `"pkg@range", "pkg@other":` headers followed by
# an indented `version "1.2.3"` line.
YARN_ENTRY_HEADER_RE: re.Pattern[str] = re.compile(r'^"?(?P<spec>[^\s].*?)"?:\s*$')
YARN_VERSION_RE: re.Pattern[str] = re.compile(r'^\s+version\s+"(?P<version>[^"]+)"')
# Only exact pins carry a resolved version worth dating; `foo>=1,<2` does not.
REQUIREMENTS_PIN_RE: re.Pattern[str] = re.compile(
    r"^(?P<name>[A-Za-z0-9._-]+)\s*==\s*(?P<version>[^\s;#]+)"
)


@dataclass(frozen=True)
class Finding:
    """One advisory against one resolved package version."""

    identifier: str
    package: str
    version: str
    ecosystem: str
    summary: str
    severity: str
    fixed_version: str | None
    source: str
    scanner: str
    aliases: tuple[str, ...] = ()
    cwes: tuple[str, ...] = ()

    @property
    def is_malware(self) -> bool:
        """Whether the advisory says the package itself is malicious."""
        identifiers = (self.identifier, *self.aliases)
        return (
            any(i.upper().startswith(MALWARE_ID_PREFIX) for i in identifiers)
            or bool(MALWARE_CWES.intersection(c.upper() for c in self.cwes))
            or bool(MALWARE_SUMMARY_RE.match(self.summary))
        )

    @property
    def key(self) -> tuple[str, str, str]:
        """Identity used to merge the same advisory seen by several scanners."""
        return (self.identifier, self.package, self.version)


@dataclass
class Suppression:
    """An allowlist entry that keeps one advisory from failing the run."""

    identifier: str
    package: str
    reason: str
    expires: date

    def covers(self, finding: Finding) -> bool:
        return self.package == finding.package and self.identifier in (
            finding.identifier,
            *finding.aliases,
        )


@dataclass
class TriageResult:
    """Outcome of a triage run."""

    malware: list[Finding] = field(default_factory=list)
    suppressed: list[tuple[Finding, Suppression]] = field(default_factory=list)
    shadowed: list[Finding] = field(default_factory=list)
    other: list[Finding] = field(default_factory=list)
    expired_suppressions: list[Suppression] = field(default_factory=list)


def _load_json(path: Path) -> Any:
    """Reads a scanner report, tolerating the empty file a clean run leaves."""
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return None
    return json.loads(text)


def _relative_path(path: str) -> str:
    """Trims the checkout prefix off the absolute paths osv-scanner reports."""
    try:
        return str(Path(path).relative_to(Path.cwd()))
    except ValueError:
        return path


def parse_osv_scanner(document: Any, source: str) -> list[Finding]:
    """Converts `osv-scanner --format json` output into findings."""
    findings: list[Finding] = []
    for result in (document or {}).get("results", []):
        path = _relative_path(result.get("source", {}).get("path", source))
        for entry in result.get("packages", []):
            package = entry.get("package", {})
            for vulnerability in entry.get("vulnerabilities", []):
                specific = vulnerability.get("database_specific", {}) or {}
                findings.append(
                    Finding(
                        identifier=vulnerability.get("id", ""),
                        package=package.get("name", ""),
                        version=package.get("version", ""),
                        ecosystem=package.get("ecosystem", ""),
                        summary=vulnerability.get("summary", "").strip(),
                        severity=specific.get("severity", "UNKNOWN"),
                        fixed_version=_osv_fixed_version(
                            vulnerability, package.get("name", "")
                        ),
                        source=path,
                        scanner="osv-scanner",
                        aliases=tuple(vulnerability.get("aliases", [])),
                        cwes=tuple(specific.get("cwe_ids", []) or []),
                    )
                )
    return findings


def _osv_fixed_version(vulnerability: dict[str, Any], package: str) -> str | None:
    """Picks the highest `fixed` event OSV lists for the affected package."""
    fixed: list[str] = []
    for affected in vulnerability.get("affected", []):
        if affected.get("package", {}).get("name") not in (package, None):
            continue
        for affected_range in affected.get("ranges", []):
            for event in affected_range.get("events", []):
                if "fixed" in event:
                    fixed.append(event["fixed"])
    return sorted(fixed)[-1] if fixed else None


def parse_npm_audit(document: Any, source: str) -> list[Finding]:
    """Converts `npm audit --json` (v2 schema) output into findings."""
    findings: list[Finding] = []
    for name, entry in (document or {}).get("vulnerabilities", {}).items():
        fix = entry.get("fixAvailable")
        fixed_version = fix.get("version") if isinstance(fix, dict) else None
        for via in entry.get("via", []):
            if not isinstance(via, dict):
                # A string `via` is a transitive pointer at another entry in
                # the same report, which is reported on its own.
                continue
            findings.append(
                Finding(
                    identifier=via.get("url", "").rsplit("/", 1)[-1]
                    or str(via.get("source", "")),
                    package=via.get("name", name),
                    version=entry.get("range", ""),
                    ecosystem="npm",
                    summary=via.get("title", "").strip(),
                    severity=via.get("severity", "unknown").upper(),
                    fixed_version=fixed_version,
                    source=source,
                    scanner="npm-audit",
                    cwes=tuple(via.get("cwe", []) or []),
                )
            )
    return findings


def parse_pip_audit(document: Any, source: str) -> list[Finding]:
    """Converts `pip-audit --format json` output into findings."""
    findings: list[Finding] = []
    for dependency in (document or {}).get("dependencies", []):
        for vulnerability in dependency.get("vulns", []):
            fix_versions = vulnerability.get("fix_versions") or []
            findings.append(
                Finding(
                    identifier=vulnerability.get("id", ""),
                    package=dependency.get("name", ""),
                    version=dependency.get("version", ""),
                    ecosystem="PyPI",
                    summary=vulnerability.get("description", "")
                    .strip()
                    .splitlines()[0][:200],
                    severity="UNKNOWN",
                    fixed_version=sorted(fix_versions)[-1] if fix_versions else None,
                    source=source,
                    scanner="pip-audit",
                    aliases=tuple(vulnerability.get("aliases", []) or []),
                )
            )
    return findings


def load_suppressions(path: Path | None) -> list[Suppression]:
    """Reads the allowlist. Entries past `expires` stop suppressing."""
    if path is None or not path.exists():
        return []
    document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    suppressions: list[Suppression] = []
    for raw in document.get("suppressions", []) or []:
        missing = {"id", "package", "reason", "expires"} - set(raw)
        if missing:
            raise ValueError(
                f"allowlist entry {raw!r} is missing {sorted(missing)}; every "
                "entry must say what it suppresses, why, and when that lapses"
            )
        expires = raw["expires"]
        suppressions.append(
            Suppression(
                identifier=raw["id"],
                package=raw["package"],
                reason=raw["reason"],
                expires=expires
                if isinstance(expires, date)
                else date.fromisoformat(str(expires)),
            )
        )
    return suppressions


def deduplicate(findings: Iterable[Finding]) -> list[Finding]:
    """Collapses the same advisory reported by more than one scanner.

    npm audit reports the affected semver range rather than the version the
    lockfile resolved, so its rows cannot be matched to osv-scanner's by
    version. Where both scanners saw the same advisory against the same
    package, the resolved version is the more useful of the two and npm
    audit's range is dropped.
    """
    collected: list[Finding] = []
    seen: set[tuple[str, str, str]] = set()
    for finding in findings:
        if finding.key not in seen:
            seen.add(finding.key)
            collected.append(finding)
    resolved = {
        (f.identifier, f.package) for f in collected if f.scanner != "npm-audit"
    }
    return [
        f
        for f in collected
        if f.scanner != "npm-audit" or (f.identifier, f.package) not in resolved
    ]


def local_npm_packages(document: Any) -> set[str]:
    """Names a package-lock.json resolves to this repository's own files.

    npm audit matches registry advisories by package name, so a workspace
    package linked in with `file:` collects the advisories filed against
    whatever was published to the registry under the same name. Those
    advisories describe code the repository does not install.
    """
    entries: dict[str, list[bool]] = {}
    for path, entry in (document or {}).get("packages", {}).items():
        # The `node_modules/` paths are the installed tree, which is what a
        # scanner reports against. The other paths are workspace sources.
        if "node_modules/" not in path:
            continue
        name = path.split("node_modules/")[-1]
        resolved = str(entry.get("resolved", ""))
        # A link, a `file:` specifier, or a bare relative path. Anything
        # carrying a URL scheme came from a registry, including a private
        # one, and stays subject to the gate.
        is_local = (
            bool(entry.get("link"))
            or resolved.startswith("file:")
            or bool(resolved and "://" not in resolved)
        )
        entries.setdefault(name, []).append(is_local)
    return {name for name, flags in entries.items() if all(flags)}


def triage(
    findings: Sequence[Finding],
    suppressions: Sequence[Suppression],
    today: date,
    local_packages: frozenset[str] = frozenset(),
) -> TriageResult:
    """Splits findings into the malware gate, suppressions, and the digest."""
    active = [s for s in suppressions if s.expires >= today]
    result = TriageResult(
        expired_suppressions=[s for s in suppressions if s.expires < today]
    )
    for finding in deduplicate(findings):
        if not finding.is_malware:
            result.other.append(finding)
            continue
        if finding.ecosystem.lower() == "npm" and finding.package in local_packages:
            result.shadowed.append(finding)
            continue
        covering = next((s for s in active if s.covers(finding)), None)
        if covering is None:
            result.malware.append(finding)
        else:
            result.suppressed.append((finding, covering))
    return result


def _finding_row(finding: Finding) -> str:
    fix = finding.fixed_version or "none published"
    return (
        f"| `{finding.package}` | {finding.version} | {finding.severity} | "
        f"{finding.identifier} | {fix} | {finding.source} |"
    )


def render_digest(result: TriageResult) -> str:
    """Renders the Markdown digest posted to the run summary."""
    lines: list[str] = ["## Advisory scan"]
    header = (
        "| Package | Version | Severity | Advisory | Fixed in | Source |\n"
        "| --- | --- | --- | --- | --- | --- |"
    )

    lines.append("")
    if result.malware:
        lines.append(f"### Malware-class advisories: {len(result.malware)} (failing)")
        lines.append("")
        lines.append(header)
        lines.extend(_finding_row(f) for f in sorted(result.malware, key=_sort_key))
    else:
        lines.append("### Malware-class advisories: none")
    lines.append("")

    if result.suppressed:
        lines.append(
            f"### Allowlisted malware-class advisories: {len(result.suppressed)}"
        )
        lines.append("")
        lines.append("| Package | Advisory | Expires | Reason |")
        lines.append("| --- | --- | --- | --- |")
        for finding, suppression in sorted(
            result.suppressed, key=lambda pair: _sort_key(pair[0])
        ):
            lines.append(
                f"| `{finding.package}` | {finding.identifier} | "
                f"{suppression.expires.isoformat()} | {suppression.reason} |"
            )
        lines.append("")

    if result.shadowed:
        lines.append(
            "### Malware-class advisories against locally-linked names: "
            f"{len(result.shadowed)}"
        )
        lines.append("")
        lines.append(
            "The lockfile resolves these names to files in this repository, not "
            "to the registry, so the advisory describes code that is not "
            "installed. They do not fail the run. They do mean the name is "
            "taken on the registry by something malicious, so dropping the "
            "local link would install malware."
        )
        lines.append("")
        lines.append(header)
        lines.extend(_finding_row(f) for f in sorted(result.shadowed, key=_sort_key))
        lines.append("")

    if result.expired_suppressions:
        lines.append("### Expired allowlist entries")
        lines.append("")
        lines.append(
            "These no longer suppress anything. Renew them with a fresh "
            "justification or delete them."
        )
        lines.append("")
        for suppression in result.expired_suppressions:
            lines.append(
                f"- `{suppression.package}` / {suppression.identifier} "
                f"(expired {suppression.expires.isoformat()})"
            )
        lines.append("")

    unfixed = [f for f in result.other if not f.fixed_version]
    lines.append(
        f"### Other advisories: {len(result.other)} "
        f"({len(unfixed)} with no published fix)"
    )
    lines.append("")
    lines.append(
        "These do not fail the run. They are the queue this job exists to keep visible."
    )
    lines.append("")
    if result.other:
        lines.append(header)
        lines.extend(_finding_row(f) for f in sorted(result.other, key=_sort_key))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


SEVERITY_ORDER: dict[str, int] = {
    "CRITICAL": 0,
    "HIGH": 1,
    "MODERATE": 2,
    "MEDIUM": 2,
    "LOW": 3,
    "INFO": 4,
    "UNKNOWN": 5,
}


def _sort_key(finding: Finding) -> tuple[int, str, str]:
    return (
        SEVERITY_ORDER.get(finding.severity.upper(), 9),
        finding.package,
        finding.identifier,
    )


def _collect(
    paths: Sequence[str],
    parser: Any,
) -> list[Finding]:
    findings: list[Finding] = []
    for raw_path in paths:
        path = Path(raw_path)
        findings.extend(parser(_load_json(path), path.name))
    return findings


def run_triage(args: argparse.Namespace) -> int:
    """Entry point for the `triage` subcommand."""
    findings = [
        *_collect(args.osv, parse_osv_scanner),
        *_collect(args.npm_audit, parse_npm_audit),
        *_collect(args.pip_audit, parse_pip_audit),
    ]
    allowlist = Path(args.allowlist) if args.allowlist else None
    local: set[str] = set()
    for raw_path in args.npm_lockfile:
        local |= local_npm_packages(_load_json(Path(raw_path)))
    result = triage(
        findings,
        load_suppressions(allowlist),
        datetime.now(timezone.utc).date(),
        frozenset(local),
    )
    digest = render_digest(result)
    if args.digest:
        Path(args.digest).write_text(digest, encoding="utf-8")
    sys.stdout.write(digest)
    if result.malware:
        sys.stderr.write(
            f"\n{len(result.malware)} malware-class advisory/advisories against "
            "packages this repository resolves. Remove the package or allowlist "
            "the advisory in the scan allowlist with a justification.\n"
        )
        return 1
    return 0


@dataclass(frozen=True)
class ResolvedPackage:
    """A package pinned by a lockfile, with the file that pinned it."""

    system: str
    name: str
    version: str
    source: str


def parse_npm_lockfile(document: Any, source: str) -> list[ResolvedPackage]:
    """Reads resolved registry packages out of a package-lock.json.

    Handles both the v2/v3 `packages` map and the v1 `dependencies` tree.
    Workspace links and `file:` entries are skipped: they are this
    repository's own code, not something fetched from the registry.
    """
    packages: list[ResolvedPackage] = []
    for path, entry in (document or {}).get("packages", {}).items():
        if not path or entry.get("link") or "version" not in entry:
            continue
        if not str(entry.get("resolved", "")).startswith("https://"):
            continue
        packages.append(
            ResolvedPackage(
                system="npm",
                name=path.split("node_modules/")[-1],
                version=entry["version"],
                source=source,
            )
        )

    def walk(tree: dict[str, Any]) -> Iterator[ResolvedPackage]:
        for name, entry in tree.items():
            if isinstance(entry, dict) and "version" in entry:
                yield ResolvedPackage("npm", name, entry["version"], source)
                yield from walk(entry.get("dependencies", {}) or {})

    packages.extend(walk((document or {}).get("dependencies", {}) or {}))
    return packages


def parse_yarn_lockfile(text: str, source: str) -> list[ResolvedPackage]:
    """Reads resolved packages out of a yarn v1 lockfile."""
    packages: list[ResolvedPackage] = []
    name: str | None = None
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        header = YARN_ENTRY_HEADER_RE.match(line)
        if header and not line.startswith(" "):
            first = header.group("spec").split(",")[0].strip().strip('"')
            # Strip the range: `@scope/pkg@^1.0.0` -> `@scope/pkg`.
            at = first.rfind("@")
            name = first[:at] if at > 0 else first
            continue
        version = YARN_VERSION_RE.match(line)
        if version and name:
            packages.append(
                ResolvedPackage("npm", name, version.group("version"), source)
            )
            name = None
    return packages


def parse_requirements(text: str, source: str) -> list[ResolvedPackage]:
    """Reads `name==version` pins out of a compiled requirements file."""
    packages: list[ResolvedPackage] = []
    for line in text.splitlines():
        match = REQUIREMENTS_PIN_RE.match(line.strip())
        if match:
            packages.append(
                ResolvedPackage(
                    system="pypi",
                    name=match.group("name"),
                    version=match.group("version"),
                    source=source,
                )
            )
    return packages


def fetch_published_at(package: ResolvedPackage) -> datetime | None:
    """Looks a release date up on deps.dev. Returns None when unknown."""
    url = DEPS_DEV_URL.format(
        system=package.system,
        name=urllib.parse.quote(package.name, safe=""),
        version=urllib.parse.quote(package.version, safe=""),
    )
    try:
        with urllib.request.urlopen(  # noqa: S310
            url, timeout=DEPS_DEV_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read())
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        # An unknown release date is not evidence of anything. The freshness
        # report is advisory, so a lookup failure drops the package from it
        # rather than failing the job.
        return None
    published = payload.get("publishedAt")
    if not published:
        return None
    return datetime.fromisoformat(published.replace("Z", "+00:00"))


@dataclass
class FreshnessReport:
    """Which resolved versions are young, out of how many were dated."""

    recent: list[tuple[ResolvedPackage, datetime]] = field(default_factory=list)
    scanned: int = 0
    undated: int = 0


def find_recent_packages(
    packages: Sequence[ResolvedPackage], days: int
) -> FreshnessReport:
    """Reports which packages resolve to a version younger than `days`."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    unique = {(p.system, p.name, p.version): p for p in packages}
    report = FreshnessReport(scanned=len(unique))
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=DEPS_DEV_WORKERS
    ) as executor:
        for package, published in zip(
            unique.values(),
            executor.map(fetch_published_at, unique.values()),
            strict=True,
        ):
            if published is None:
                report.undated += 1
            elif published >= cutoff:
                report.recent.append((package, published))
    report.recent.sort(key=lambda pair: pair[1], reverse=True)
    return report


def render_freshness(report: FreshnessReport, days: int) -> str:
    """Renders the Markdown digest for the freshness check."""
    lines = [
        f"## Dependencies published in the last {days} days",
        "",
        f"{len(report.recent)} of {report.scanned} resolved package versions, "
        f"{report.undated} of which deps.dev could not date. This mirrors the "
        "`cooldown` Dependabot applies to its own pull requests; a dependency "
        "that arrived by another route has not had that soak time.",
        "",
    ]
    if not report.recent:
        lines.append("None.")
        return "\n".join(lines) + "\n"
    lines.append("| Package | Version | Published | Ecosystem | Source |")
    lines.append("| --- | --- | --- | --- | --- |")
    for package, published in report.recent:
        lines.append(
            f"| `{package.name}` | {package.version} | "
            f"{published.date().isoformat()} | {package.system} | "
            f"{package.source} |"
        )
    return "\n".join(lines) + "\n"


def run_freshness(args: argparse.Namespace) -> int:
    """Entry point for the `freshness` subcommand."""
    packages: list[ResolvedPackage] = []
    for raw_path in args.npm_lockfile:
        path = Path(raw_path)
        packages.extend(parse_npm_lockfile(_load_json(path), raw_path))
    for raw_path in args.yarn_lockfile:
        packages.extend(
            parse_yarn_lockfile(Path(raw_path).read_text(encoding="utf-8"), raw_path)
        )
    for raw_path in args.requirements:
        packages.extend(
            parse_requirements(Path(raw_path).read_text(encoding="utf-8"), raw_path)
        )
    digest = render_freshness(find_recent_packages(packages, args.days), args.days)
    if args.digest:
        Path(args.digest).write_text(digest, encoding="utf-8")
    sys.stdout.write(digest)
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Builds the CLI."""
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    triage_parser = subparsers.add_parser(
        "triage", help="classify scanner reports and gate on malware only"
    )
    triage_parser.add_argument("--osv", action="append", default=[])
    triage_parser.add_argument("--npm-audit", action="append", default=[])
    triage_parser.add_argument("--pip-audit", action="append", default=[])
    triage_parser.add_argument(
        "--npm-lockfile",
        action="append",
        default=[],
        help="package-lock.json used to tell locally-linked names from "
        "registry packages",
    )
    triage_parser.add_argument("--allowlist")
    triage_parser.add_argument("--digest")
    triage_parser.set_defaults(handler=run_triage)

    freshness_parser = subparsers.add_parser(
        "freshness", help="report dependencies published within the cooldown window"
    )
    freshness_parser.add_argument("--npm-lockfile", action="append", default=[])
    freshness_parser.add_argument("--yarn-lockfile", action="append", default=[])
    freshness_parser.add_argument("--requirements", action="append", default=[])
    freshness_parser.add_argument("--days", type=int, default=7)
    freshness_parser.add_argument("--digest")
    freshness_parser.set_defaults(handler=run_freshness)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Parses arguments and dispatches to the selected subcommand."""
    args = build_parser().parse_args(argv)
    handler: Any = args.handler
    return int(handler(args))


if __name__ == "__main__":
    sys.exit(main())
