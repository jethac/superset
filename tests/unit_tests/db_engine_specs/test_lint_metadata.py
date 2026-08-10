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

from typing import Any

from superset.db_engine_specs.lint_metadata import (
    analyze_spec,
    get_all_engine_specs_ast,
    validate_documentation_references,
)

COMPLETE_METADATA = {
    "description": "A database.",
    "categories": ["DatabaseCategory.OTHER"],
    "pypi_packages": ["a-driver"],
    "connection_string": "a://{username}:{password}@{host}:{port}/{database}",
}


def spec(
    class_name: str,
    metadata: dict[str, Any] | None = None,
    documented_by: str | None = None,
) -> dict[str, Any]:
    return {
        "class_name": class_name,
        "engine_name": class_name,
        "module": "example",
        "metadata": metadata or {},
        "documented_by": documented_by,
    }


def test_deferred_spec_is_exempt() -> None:
    specs = [
        spec("AEngineSpec", COMPLETE_METADATA),
        spec("AVariantEngineSpec", documented_by="AEngineSpec"),
    ]
    validate_documentation_references(specs)
    reports = [analyze_spec(s) for s in specs]

    assert [r.is_exempt for r in reports] == [False, True]
    assert reports[1].documented_by == "AEngineSpec"
    assert reports[1].documented_by_error is None


def test_spec_without_metadata_or_deferral_is_not_exempt() -> None:
    specs = [spec("AEngineSpec")]
    validate_documentation_references(specs)

    report = analyze_spec(specs[0])
    assert not report.is_exempt
    assert report.missing_required


def test_deferral_to_unknown_spec_is_reported() -> None:
    specs = [spec("AVariantEngineSpec", documented_by="MissingEngineSpec")]
    validate_documentation_references(specs)

    assert analyze_spec(specs[0]).documented_by_error == (
        "MissingEngineSpec is not an engine spec"
    )


def test_deferral_to_undocumented_spec_is_reported() -> None:
    specs = [
        spec("AEngineSpec"),
        spec("AVariantEngineSpec", documented_by="AEngineSpec"),
    ]
    validate_documentation_references(specs)

    assert analyze_spec(specs[1]).documented_by_error == (
        "AEngineSpec has no metadata of its own"
    )


def test_self_deferral_is_reported() -> None:
    specs = [spec("AEngineSpec", documented_by="AEngineSpec")]
    validate_documentation_references(specs)

    assert analyze_spec(specs[0]).documented_by_error == "points at itself"


def test_metadata_and_deferral_together_is_reported() -> None:
    specs = [
        spec("AEngineSpec", COMPLETE_METADATA),
        spec("BEngineSpec", COMPLETE_METADATA, documented_by="AEngineSpec"),
    ]
    validate_documentation_references(specs)

    assert analyze_spec(specs[1]).documented_by_error == (
        "declares both `metadata` and `metadata_documented_by`"
    )


def test_repo_specs_have_metadata_or_a_valid_deferral() -> None:
    specs = get_all_engine_specs_ast()
    validate_documentation_references(specs)
    reports = [analyze_spec(s) for s in specs]

    assert not [r.class_name for r in reports if r.documented_by_error]
    assert not [r.class_name for r in reports if not r.is_exempt and r.missing_required]
