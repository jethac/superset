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

from __future__ import annotations

from typing import Any

from superset.db_engine_specs.lint_metadata import (
    get_all_engine_specs_ast,
    is_connectable,
    REQUIRED_FIELDS,
    resolve_metadata,
)


def _class_info(**overrides: Any) -> dict[str, Any]:
    class_info: dict[str, Any] = {
        "class_name": "SomeEngineSpec",
        "engine_name": "Some Database",
        "module": "some",
        "bases": [],
        "engine": "some",
        "metadata": {},
        "is_engine_spec": True,
    }
    class_info.update(overrides)
    return class_info


def test_connectable_requires_engine_and_engine_name() -> None:
    assert is_connectable(_class_info())
    assert not is_connectable(_class_info(engine=None, engine_name=None))
    # PostgresBaseEngineSpec shares an engine_name with the product spec but
    # declares an empty engine, so it is not selectable.
    assert not is_connectable(_class_info(engine="", engine_name="PostgreSQL"))
    # A spec declaring an engine_name while inheriting its engine is linted
    # rather than silently exempted.
    assert is_connectable(_class_info(engine="some", engine_name="Some Database"))


def test_resolve_metadata_walks_base_classes() -> None:
    classes = {
        "GrandParentSpec": _class_info(
            class_name="GrandParentSpec", metadata={"description": "grandparent"}
        ),
        "ParentSpec": _class_info(class_name="ParentSpec", bases=["GrandParentSpec"]),
        "ChildSpec": _class_info(class_name="ChildSpec", bases=["ParentSpec"]),
    }

    assert resolve_metadata("ChildSpec", classes) == (
        {"description": "grandparent"},
        "GrandParentSpec",
    )


def test_resolve_metadata_prefers_the_nearest_declaration() -> None:
    classes = {
        "ParentSpec": _class_info(
            class_name="ParentSpec", metadata={"description": "parent"}
        ),
        "ChildSpec": _class_info(
            class_name="ChildSpec",
            bases=["ParentSpec"],
            metadata={"description": "child"},
        ),
    }

    assert resolve_metadata("ChildSpec", classes) == (
        {"description": "child"},
        "ChildSpec",
    )


def test_resolve_metadata_without_any_declaration() -> None:
    classes = {"ChildSpec": _class_info(class_name="ChildSpec", bases=["Unknown"])}

    assert resolve_metadata("ChildSpec", classes) == ({}, None)


def test_base_classes_are_exempt() -> None:
    specs = {spec["class_name"]: spec for spec in get_all_engine_specs_ast()}

    assert not specs["PostgresBaseEngineSpec"]["connectable"]
    assert not specs["PrestoBaseEngineSpec"]["connectable"]
    assert specs["PostgresEngineSpec"]["connectable"]
    assert specs["PrestoEngineSpec"]["connectable"]


def test_every_connectable_spec_resolves_required_fields() -> None:
    incomplete = {
        spec["class_name"]: sorted(set(REQUIRED_FIELDS) - set(spec["metadata"]))
        for spec in get_all_engine_specs_ast()
        if spec["connectable"] and set(REQUIRED_FIELDS) - set(spec["metadata"] or {})
    }

    assert incomplete == {}
