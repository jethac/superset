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

"""
Metadata completeness linter for DB engine specs.

This script validates that all DB engine specs have complete metadata
as defined by the DBEngineSpecMetadata TypedDict in base.py.

Usage:
    python superset/db_engine_specs/lint_metadata.py [--json] [--strict]

Options:
    --json      Output results as JSON
    --strict    Return non-zero exit code if any required fields are missing
    --help      Show this help message

The script categorizes metadata fields into:
- REQUIRED: Must be present for proper documentation
- RECOMMENDED: Should be present for good documentation
- OPTIONAL: Nice to have but not critical

Only specs that can back a database connection are linted: a class needs both a
non-empty ``engine`` and an ``engine_name`` to be offered as a database, so the
shared base classes that have neither are reported as exempt instead. Because
``metadata`` is an ordinary class attribute, a spec that declares none serves
its nearest ancestor's, and the linter resolves it the same way.

Example output:
    === Metadata Completeness Report ===

    PostgreSQL (postgres.py)
      ✓ description, category, pypi_packages, connection_string
      ⚠ Missing recommended: logo, homepage_url

    MySQL (mysql.py)
      ✓ All required and recommended fields present
"""

from __future__ import annotations

import argparse
import json  # noqa: TID251 - standalone script, don't depend on superset.utils
import sys
from dataclasses import dataclass
from typing import Any

# Schema definition - fields grouped by importance
REQUIRED_FIELDS = {
    "description": "Brief description of the database",
    "categories": "List of DatabaseCategory constants for grouping",
    "pypi_packages": "Python packages needed for connection",
    "connection_string": "SQLAlchemy URI template",
}

RECOMMENDED_FIELDS = {
    "logo": "Logo filename (in docs/static/img/databases/)",
    "homepage_url": "Official database homepage",
    "default_port": "Default port number",
}

OPTIONAL_FIELDS = {
    "docs_url": "Documentation URL",
    "sqlalchemy_docs_url": "SQLAlchemy dialect documentation",
    "notes": "Additional configuration notes",
    "warnings": "Important warnings for users",
    "limitations": "Known limitations (no JOINs, row limits, etc.)",
    "install_instructions": "How to install the driver",
    "version_requirements": "Version compatibility info",
    "connection_examples": "Example connection strings",
    "authentication_methods": "Supported auth methods",
    "drivers": "Available driver options",
    "compatible_databases": "Related/compatible databases",
    "engine_parameters": "Advanced JSON config options",
    "host_examples": "Platform-specific host examples",
    "ssl_configuration": "SSL setup documentation",
    "advanced_features": "Advanced feature documentation",
    "parameters": "Connection parameter descriptions",
    "tutorials": "Tutorial links",
}

# Cache for PyPI package validation
_pypi_cache: dict[str, bool] = {}


def check_pypi_package(package_name: str, timeout: float = 5.0) -> bool:
    """Check if a package exists on PyPI."""
    import urllib.error
    import urllib.request

    # Strip version specifiers and extras
    base_name = package_name.split("[")[0].split(">")[0].split("<")[0].split("=")[0]
    base_name = base_name.strip()

    if base_name in _pypi_cache:
        return _pypi_cache[base_name]

    url = f"https://pypi.org/pypi/{base_name}/json"
    try:
        req = urllib.request.Request(  # noqa: S310
            url, headers={"User-Agent": "superset-lint/1.0"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:  # noqa: S310
            exists = response.status == 200
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        exists = False

    _pypi_cache[base_name] = exists
    return exists


def validate_pypi_packages(
    packages: list[str], timeout: float = 5.0
) -> tuple[list[str], list[str]]:
    """Validate a list of PyPI packages. Returns (valid, invalid) lists."""
    valid = []
    invalid = []
    for pkg in packages:
        if check_pypi_package(pkg, timeout):
            valid.append(pkg)
        else:
            invalid.append(pkg)
    return valid, invalid


@dataclass
class MetadataReport:
    """Report for a single engine spec's metadata."""

    engine_name: str
    module: str
    has_metadata: bool
    present_fields: set[str]
    missing_required: set[str]
    missing_recommended: set[str]
    missing_optional: set[str]
    completeness_score: float  # 0-100
    invalid_packages: list[str] | None = None  # PyPI packages that don't exist
    limitations: list[str] | None = None  # Known limitations
    inherited_from: str | None = None  # Ancestor class declaring the metadata

    def to_dict(self) -> dict[str, Any]:
        result = {
            "engine_name": self.engine_name,
            "module": self.module,
            "has_metadata": self.has_metadata,
            "inherited_from": self.inherited_from,
            "present_fields": sorted(self.present_fields),
            "missing_required": sorted(self.missing_required),
            "missing_recommended": sorted(self.missing_recommended),
            "missing_optional": sorted(self.missing_optional),
            "completeness_score": self.completeness_score,
        }
        if self.invalid_packages is not None:
            result["invalid_packages"] = self.invalid_packages
        if self.limitations is not None:
            result["limitations"] = self.limitations
        return result


def analyze_spec(spec_data: dict[str, Any], check_pypi: bool = False) -> MetadataReport:
    """Analyze a single engine spec for metadata completeness."""
    metadata = spec_data.get("metadata", {})
    engine_name = spec_data.get("engine_name", spec_data.get("class_name", "Unknown"))
    module = spec_data.get("module", "unknown")

    # Handle unparseable metadata
    if metadata.get("_unparseable"):
        metadata = {}

    present = set(metadata.keys()) if metadata else set()
    missing_required = set(REQUIRED_FIELDS.keys()) - present
    missing_recommended = set(RECOMMENDED_FIELDS.keys()) - present
    missing_optional = set(OPTIONAL_FIELDS.keys()) - present

    # Calculate completeness score
    # Required fields: 60%, Recommended: 30%, Optional: 10%
    total_required = len(REQUIRED_FIELDS)
    total_recommended = len(RECOMMENDED_FIELDS)
    total_optional = len(OPTIONAL_FIELDS)

    required_present = total_required - len(missing_required)
    recommended_present = total_recommended - len(missing_recommended)
    optional_present = total_optional - len(missing_optional)

    score = (
        (required_present / total_required) * 60
        + (recommended_present / total_recommended) * 30
        + (optional_present / total_optional) * 10
    )

    # Validate PyPI packages if requested
    invalid_packages = None
    if check_pypi and metadata.get("pypi_packages"):
        packages = metadata.get("pypi_packages", [])
        if packages:
            _, invalid_packages = validate_pypi_packages(packages)

    # Extract limitations
    limitations = metadata.get("limitations") if metadata else None

    return MetadataReport(
        engine_name=engine_name,
        module=module,
        has_metadata=bool(metadata),
        present_fields=present,
        missing_required=missing_required,
        missing_recommended=missing_recommended,
        missing_optional=missing_optional,
        completeness_score=round(score, 1),
        invalid_packages=invalid_packages,
        limitations=limitations,
        inherited_from=spec_data.get("inherited_from"),
    )


def _parse_class_defs() -> dict[str, dict[str, Any]]:  # noqa: C901
    """
    Collect one entry per class defined in the ``db_engine_specs`` package.

    Every class is collected, including the shared base classes, because the
    ``metadata`` attribute is inherited: resolving a spec's effective metadata
    requires walking its base classes.
    """
    import ast
    import os

    classes: dict[str, dict[str, Any]] = {}
    db_engine_specs_dir = os.path.dirname(__file__)

    for filename in sorted(os.listdir(db_engine_specs_dir)):
        if not filename.endswith(".py"):
            continue

        filepath = os.path.join(db_engine_specs_dir, filename)
        try:
            with open(filepath) as f:
                content = f.read()

            tree = ast.parse(content)

            for node in ast.walk(tree):
                if not isinstance(node, ast.ClassDef):
                    continue

                bases = [
                    name
                    for name in (_base_name(base) for base in node.bases)
                    if name is not None
                ]
                engine: str | None = None
                engine_name: str | None = None
                metadata: dict[str, Any] = {}

                for item in node.body:
                    if not isinstance(item, ast.Assign):
                        continue
                    for target in item.targets:
                        if not isinstance(target, ast.Name):
                            continue
                        if target.id == "engine":
                            if isinstance(item.value, ast.Constant):
                                engine = item.value.value
                        elif target.id == "engine_name":
                            if isinstance(item.value, ast.Constant):
                                engine_name = item.value.value
                        elif target.id == "metadata":
                            try:
                                metadata = _eval_ast_dict(item.value)
                            except Exception:
                                # Mark as unparseable
                                metadata = {"_unparseable": True}

                classes[node.name] = {
                    "class_name": node.name,
                    "engine_name": engine_name,
                    "module": filename[:-3],  # Remove .py
                    "bases": bases,
                    "engine": engine,
                    "metadata": metadata,
                    "is_engine_spec": any("EngineSpec" in base for base in bases),
                }

        except Exception as e:
            print(f"Warning: Could not parse {filename}: {e}", file=sys.stderr)

    return classes


def _base_name(node: Any) -> str | None:
    """Return the name of a base class as written in the class definition."""
    import ast

    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def is_connectable(class_info: dict[str, Any]) -> bool:
    """
    Return whether a spec class can back a database connection.

    A spec is only reachable from the UI when it binds to a SQLAlchemy backend
    through a non-empty ``engine`` and labels itself with an ``engine_name``;
    ``superset.db_engine_specs.lib`` uses the same ``engine`` test when it
    decides which spec is authoritative for a name. Classes that declare an
    empty ``engine`` (``PostgresBaseEngineSpec``) or no ``engine_name`` at all
    (``PrestoBaseEngineSpec``) exist to share behaviour with their subclasses,
    are never offered as a database to connect to, and therefore have nothing
    to document. A class that declares an ``engine_name`` while inheriting its
    ``engine`` is treated as connectable, so an unusual spec is reported rather
    than silently exempted.
    """
    return bool(class_info["engine"]) and bool(class_info["engine_name"])


def resolve_metadata(
    class_name: str, classes: dict[str, dict[str, Any]]
) -> tuple[dict[str, Any], str | None]:
    """
    Resolve the ``metadata`` a spec class exposes at runtime.

    ``metadata`` is a plain class attribute, so a spec that does not declare one
    serves its nearest ancestor's — which is the value
    ``superset.db_engine_specs.lib`` reads when it generates documentation.
    Returns the metadata along with the class that declares it, or ``None`` when
    no class in the hierarchy declares a non-empty value.
    """
    queue = [class_name]
    seen: set[str] = set()

    while queue:
        name = queue.pop(0)
        if name in seen or name not in classes:
            continue
        seen.add(name)
        class_info = classes[name]
        if class_info["metadata"]:
            return class_info["metadata"], name
        queue.extend(class_info["bases"])

    return {}, None


def get_all_engine_specs_ast() -> list[dict[str, Any]]:
    """
    Discover all DB engine specs using AST parsing.

    This avoids needing to initialize the Flask app. Returns a list of dicts
    with engine_name, module, metadata (resolved through the class hierarchy),
    and whether the spec can back a database connection.
    """
    excluded_modules = ("__init__", "base", "lint_metadata", "lib")
    classes = _parse_class_defs()
    specs = []

    for class_info in classes.values():
        if not class_info["is_engine_spec"]:
            continue
        if "Mixin" in class_info["class_name"]:
            continue
        if class_info["module"] in excluded_modules:
            continue

        metadata, declared_by = resolve_metadata(class_info["class_name"], classes)
        specs.append(
            {
                "class_name": class_info["class_name"],
                "engine_name": class_info["engine_name"] or class_info["class_name"],
                "module": class_info["module"],
                "metadata": metadata,
                "inherited_from": (
                    declared_by if declared_by != class_info["class_name"] else None
                ),
                "connectable": is_connectable(class_info),
            }
        )

    return sorted(specs, key=lambda s: s["engine_name"])


def _eval_ast_dict(node: Any) -> dict[str, Any]:
    """Safely evaluate an AST node as a dict literal."""
    import ast

    if isinstance(node, ast.Dict):
        result = {}
        for k, v in zip(node.keys, node.values, strict=False):
            if k is None:
                continue
            key = _eval_ast_value(k)
            value = _eval_ast_value(v)
            if key is not None:
                result[key] = value
        return result
    return {}


def _eval_ast_value(node: Any) -> Any:  # noqa: C901
    """Safely evaluate an AST node as a value."""
    import ast

    if isinstance(node, ast.Constant):
        return node.value
    elif isinstance(node, ast.Str):  # Python 3.7 compat
        return node.s
    elif isinstance(node, ast.Num):  # Python 3.7 compat
        return node.n
    elif isinstance(node, ast.List):
        return [_eval_ast_value(e) for e in node.elts]
    elif isinstance(node, ast.Dict):
        return _eval_ast_dict(node)
    elif isinstance(node, ast.Name):
        # Handle DatabaseCategory.* constants
        return node.id
    elif isinstance(node, ast.Attribute):
        # Handle DatabaseCategory.TRADITIONAL_RDBMS etc
        if hasattr(ast, "unparse"):
            return ast.unparse(node)
        return f"{_eval_ast_value(node.value)}.{node.attr}"
    elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        # String concatenation
        left = _eval_ast_value(node.left)
        right = _eval_ast_value(node.right)
        if isinstance(left, str) and isinstance(right, str):
            return left + right
        return None
    elif isinstance(node, ast.JoinedStr):
        # f-strings - just return placeholder
        return "<f-string>"
    elif isinstance(node, ast.Tuple):
        return tuple(_eval_ast_value(e) for e in node.elts)
    return None


def get_all_engine_specs() -> list[type]:
    """Discover all DB engine specs using Flask app (if available)."""
    # Import here to avoid issues when running standalone
    from superset.db_engine_specs import load_engine_specs

    specs = []
    for spec in load_engine_specs():
        # Skip base classes and internal specs
        if spec.__name__ in ("BaseEngineSpec", "BasicParametersMixin"):
            continue
        specs.append(spec)

    return sorted(specs, key=lambda s: getattr(s, "engine_name", s.__name__))


def print_report(  # noqa: C901
    reports: list[MetadataReport],
    verbose: bool = False,
    exempt: list[dict[str, Any]] | None = None,
) -> None:
    """Print a human-readable report."""
    print("\n" + "=" * 60)
    print("METADATA COMPLETENESS REPORT")
    print("=" * 60 + "\n")

    # Summary statistics
    total = len(reports)
    with_metadata = sum(1 for r in reports if r.has_metadata)
    fully_complete = sum(1 for r in reports if not r.missing_required)
    avg_score = sum(r.completeness_score for r in reports) / total if total else 0

    print(f"Total engine specs:     {total}")
    print(f"With metadata:          {with_metadata} ({with_metadata * 100 // total}%)")
    print(
        f"All required fields:    {fully_complete} ({fully_complete * 100 // total}%)"
    )
    print(f"Average completeness:   {avg_score:.1f}%")
    if exempt:
        print(f"Exempt base classes:    {len(exempt)}")
    print()

    # Group by completeness
    complete = [
        r for r in reports if not r.missing_required and not r.missing_recommended
    ]
    needs_work = [r for r in reports if r.missing_required or r.missing_recommended]
    no_metadata = [r for r in reports if not r.has_metadata]

    if complete:
        print(f"\n✅ COMPLETE ({len(complete)} specs - all required & recommended):")
        print("-" * 50)
        for r in complete:
            print(f"  {r.engine_name:30} {r.completeness_score:5.1f}%")

    if needs_work:
        print(f"\n⚠️  NEEDS WORK ({len(needs_work)} specs):")
        print("-" * 50)
        for r in sorted(needs_work, key=lambda x: -x.completeness_score):
            status = []
            if r.missing_required:
                status.append(
                    f"missing required: {', '.join(sorted(r.missing_required))}"
                )
            if r.missing_recommended:
                status.append(
                    f"missing recommended: {', '.join(sorted(r.missing_recommended))}"
                )
            print(f"  {r.engine_name:30} {r.completeness_score:5.1f}%")
            for s in status:
                print(f"      └─ {s}")

    if no_metadata:
        print(f"\n❌ NO METADATA ({len(no_metadata)} specs):")
        print("-" * 50)
        for r in no_metadata:
            print(f"  {r.engine_name} ({r.module}.py)")

    inherited = [r for r in reports if r.inherited_from]
    if inherited:
        print(
            f"\n🧬 INHERITED ({len(inherited)} specs - metadata declared by an "
            "ancestor):"
        )
        print("-" * 50)
        for r in sorted(inherited, key=lambda x: x.engine_name):
            print(f"  {r.engine_name:30} ← {r.inherited_from}")

    if exempt:
        print(
            f"\n➖ EXEMPT ({len(exempt)} base classes - no engine/engine_name, so "
            "never offered as a connection):"
        )
        print("-" * 50)
        for spec in sorted(exempt, key=lambda s: str(s["class_name"])):
            print(f"  {spec['class_name']} ({spec['module']}.py)")

    # Show invalid PyPI packages
    invalid_pypi = [r for r in reports if r.invalid_packages]
    if invalid_pypi:
        print(f"\n📦 INVALID PyPI PACKAGES ({len(invalid_pypi)} specs):")
        print("-" * 50)
        for r in invalid_pypi:
            packages = r.invalid_packages or []
            print(f"  {r.engine_name}: {', '.join(packages)}")

    # Field coverage summary
    print("\n" + "=" * 60)
    print("FIELD COVERAGE SUMMARY")
    print("=" * 60)

    all_fields = {**REQUIRED_FIELDS, **RECOMMENDED_FIELDS, **OPTIONAL_FIELDS}
    field_counts: dict[str, int] = dict.fromkeys(all_fields, 0)

    for r in reports:
        for field in r.present_fields:
            if field in field_counts:
                field_counts[field] += 1

    print("\nRequired fields:")
    for field, _desc in REQUIRED_FIELDS.items():
        count = field_counts[field]
        pct = count * 100 // total
        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
        print(f"  {field:25} {bar} {count:3}/{total} ({pct}%)")

    print("\nRecommended fields:")
    for field, _desc in RECOMMENDED_FIELDS.items():
        count = field_counts[field]
        pct = count * 100 // total
        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
        print(f"  {field:25} {bar} {count:3}/{total} ({pct}%)")

    if verbose:
        print("\nOptional fields:")
        for field, _desc in OPTIONAL_FIELDS.items():
            count = field_counts[field]
            pct = count * 100 // total
            bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
            print(f"  {field:25} {bar} {count:3}/{total} ({pct}%)")


def generate_markdown_report(
    reports: list[MetadataReport], exempt: list[dict[str, Any]] | None = None
) -> str:
    """Generate a markdown report suitable for checking into the repo."""
    lines = [
        "<!--",
        "Licensed to the Apache Software Foundation (ASF) under one",
        "or more contributor license agreements.  See the NOTICE file",
        "distributed with this work for additional information",
        "regarding copyright ownership.  The ASF licenses this file",
        "to you under the Apache License, Version 2.0 (the",
        '"License"); you may not use this file except in compliance',
        "with the License.  You may obtain a copy of the License at",
        "",
        "  http://www.apache.org/licenses/LICENSE-2.0",
        "",
        "Unless required by applicable law or agreed to in writing,",
        "software distributed under the License is distributed on an",
        '"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY',
        "KIND, either express or implied.  See the License for the",
        "specific language governing permissions and limitations",
        "under the License.",
        "-->",
        "",
        "# Database Metadata Completeness Report",
        "",
        "This report is auto-generated by "
        "`python superset/db_engine_specs/lint_metadata.py --markdown`.",
        "It tracks which database engine specs have complete metadata.",
        "",
        "## Summary",
        "",
    ]

    total = len(reports)
    with_metadata = sum(1 for r in reports if r.has_metadata)
    all_required = sum(1 for r in reports if not r.missing_required)
    avg_score = sum(r.completeness_score for r in reports) / total if total else 0

    pct_meta = with_metadata * 100 // total
    pct_req = all_required * 100 // total
    lines.extend(
        [
            f"- **Total engine specs:** {total}",
            f"- **With metadata:** {with_metadata} ({pct_meta}%)",
            f"- **All required fields:** {all_required} ({pct_req}%)",
            f"- **Average completeness:** {avg_score:.1f}%",
            f"- **Exempt base classes:** {len(exempt or [])}",
            "",
            "## Required Fields",
            "",
            "These fields should be in every engine spec's `metadata` attribute:",
            "",
        ]
    )

    for field, desc in REQUIRED_FIELDS.items():
        lines.append(f"- `{field}` - {desc}")

    lines.extend(
        [
            "",
            "## Specs Needing Work",
            "",
            "| Engine | Module | Score | Missing Required | Missing Recommended |",
            "|--------|--------|-------|------------------|---------------------|",
        ]
    )

    # Sort by score ascending (worst first)
    needs_work = [r for r in reports if r.missing_required or r.missing_recommended]
    for r in sorted(needs_work, key=lambda x: x.completeness_score):
        missing_req = ", ".join(sorted(r.missing_required)) or "✓"
        missing_rec = ", ".join(sorted(r.missing_recommended)) or "✓"
        score = f"{r.completeness_score:.0f}%"
        row = f"| {r.engine_name} | {r.module}.py | {score} | {missing_req} | {missing_rec} |"  # noqa: E501
        lines.append(row)

    lines.extend(
        [
            "",
            "## Complete Specs",
            "",
            "These specs have all required and recommended fields:",
            "",
        ]
    )

    complete = [
        r for r in reports if not r.missing_required and not r.missing_recommended
    ]
    for r in sorted(complete, key=lambda x: x.engine_name):
        lines.append(f"- {r.engine_name} ({r.completeness_score:.0f}%)")

    inherited = [r for r in reports if r.inherited_from]
    if inherited:
        lines.extend(
            [
                "",
                "## Specs Inheriting Metadata",
                "",
                "`metadata` is a class attribute, so these specs serve the metadata "
                "declared by an ancestor:",
                "",
            ]
        )
        for r in sorted(inherited, key=lambda x: x.engine_name):
            lines.append(f"- {r.engine_name} ← `{r.inherited_from}`")

    if exempt:
        lines.extend(
            [
                "",
                "## Exempt Base Classes",
                "",
                "These classes declare no `engine` or no `engine_name`, so they are "
                "never offered as a database to connect to and carry no metadata:",
                "",
            ]
        )
        for spec in sorted(exempt, key=lambda s: str(s["class_name"])):
            lines.append(f"- `{spec['class_name']}` ({spec['module']}.py)")

    lines.extend(
        [
            "",
            "## How to Fix",
            "",
            "Add a `metadata` attribute to your engine spec class:",
            "",
            "```python",
            "from superset.db_engine_specs.base import (",  # noqa: E501
            "    BaseEngineSpec, DatabaseCategory",
            ")",
            "",
            "class MyEngineSpec(BaseEngineSpec):",
            '    engine_name = "My Database"',
            "",
            "    metadata = {",
            '        "description": "Brief description of the database.",',
            '        "categories": [DatabaseCategory.TRADITIONAL_RDBMS],',
            '        "pypi_packages": ["my-driver"],',
            '        "connection_string": "mydb://{username}:{password}@{host}:{port}/{database}",',
            '        "logo": "mydb.svg",',
            '        "homepage_url": "https://mydb.example.com/",',
            '        "default_port": 5432,',
            "    }",
            "```",
            "",
            "See `superset/db_engine_specs/README.md` for full documentation.",
            "",
        ]
    )

    return "\n".join(lines)


def check_strict(reports: list[MetadataReport], check_pypi: bool = False) -> int:
    """
    Return a process exit code for strict mode.

    Every spec that can back a database connection must resolve all required
    fields, whether it declares them itself or inherits them from an ancestor.
    Base classes that cannot back a connection are not reported at all.
    """
    incomplete = [r for r in reports if r.missing_required]
    if incomplete:
        print(
            f"\n❌ STRICT MODE: {len(incomplete)} specs missing required fields",
            file=sys.stderr,
        )
        for report in sorted(incomplete, key=lambda r: r.engine_name):
            fields = ", ".join(sorted(report.missing_required))
            print(
                f"  {report.engine_name} ({report.module}.py): {fields}",
                file=sys.stderr,
            )
        return 1

    invalid_pypi_count = sum(1 for r in reports if r.invalid_packages)
    if check_pypi and invalid_pypi_count > 0:
        print(
            f"\n❌ STRICT MODE: {invalid_pypi_count} specs have invalid packages",
            file=sys.stderr,
        )
        return 1

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Lint DB engine spec metadata for completeness"
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--markdown", action="store_true", help="Output as Markdown report"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with error if required fields missing",
    )
    parser.add_argument(
        "--check-pypi",
        action="store_true",
        help="Validate that pypi_packages exist on PyPI (slower)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Show optional field coverage"
    )
    parser.add_argument("--output", "-o", type=str, help="Write output to file")
    args = parser.parse_args()

    # Use AST parsing to avoid Flask app dependency
    all_specs = get_all_engine_specs_ast()
    specs = [spec for spec in all_specs if spec["connectable"]]
    exempt = [spec for spec in all_specs if not spec["connectable"]]

    if not specs:
        print("Error: No engine specs found.", file=sys.stderr)
        return 1

    if args.check_pypi:
        print("Validating PyPI packages (this may take a moment)...", file=sys.stderr)

    reports = [analyze_spec(spec, check_pypi=args.check_pypi) for spec in specs]

    # Generate output
    output_text = ""
    if args.json:
        output_data = {
            "summary": {
                "total": len(reports),
                "with_metadata": sum(1 for r in reports if r.has_metadata),
                "all_required": sum(1 for r in reports if not r.missing_required),
                "average_score": round(
                    sum(r.completeness_score for r in reports) / len(reports), 1
                ),
            },
            "schema": {
                "required": REQUIRED_FIELDS,
                "recommended": RECOMMENDED_FIELDS,
                "optional": OPTIONAL_FIELDS,
            },
            "reports": [r.to_dict() for r in reports],
            "exempt": [
                {"class_name": spec["class_name"], "module": spec["module"]}
                for spec in exempt
            ],
        }
        output_text = json.dumps(output_data, indent=2)
    elif args.markdown:
        output_text = generate_markdown_report(reports, exempt)
    else:
        print_report(reports, verbose=args.verbose, exempt=exempt)

    # Write to file or stdout
    if output_text:
        if args.output:
            with open(args.output, "w") as f:
                f.write(output_text)
            print(f"Report written to {args.output}", file=sys.stderr)
        else:
            print(output_text)

    if args.strict:
        return check_strict(reports, check_pypi=args.check_pypi)

    return 0


if __name__ == "__main__":
    sys.exit(main())
