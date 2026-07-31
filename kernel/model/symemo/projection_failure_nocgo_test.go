// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//go:build !cgo

package symemo

import (
	"os"
	"path/filepath"
	"testing"
)

func installProjectionRefreshFailure(t *testing.T, _ *Engine, config Config) func() {
	t.Helper()
	indexPath := config.IndexPath()
	if err := os.Remove(indexPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(indexPath, 0755); err != nil {
		t.Fatal(err)
	}
	restored := false
	restore := func() {
		if restored {
			return
		}
		restored = true
		if err := os.RemoveAll(indexPath); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(indexPath), 0755); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(restore)
	return restore
}

func writeProjectionSchemaMismatch(t *testing.T, engine *Engine) {
	t.Helper()
	engine.index.mu.Lock()
	defer engine.index.mu.Unlock()
	engine.index.data.SchemaVersion = 0
	if err := engine.index.saveLocked(); err != nil {
		t.Fatal(err)
	}
}

func corruptProjectionPayload(t *testing.T, engine *Engine) {
	t.Helper()
	projection := engine.index.data.Projections[fixtureElementID]
	projection.AlgorithmStates = map[string]VersionedAlgorithmState{
		"corrupt": {Algorithm: "corrupt", SchemaVersion: 1, State: func() {}},
	}
	engine.index.data.Projections[fixtureElementID] = projection
}

func TestItemProjectionRebuildCGOParity(t *testing.T) {
	engine, config, item := newItemAuthorityEngine(t, supportedTestItem("20260731195100-cgopar", "CGO question", "CGO answer", "rev-cgo"))
	before, err := engine.Query(t.Context(), Query{Kind: QueryItemAuthoring, ElementID: item.ID})
	if err != nil || before.ItemAuthoring == nil {
		t.Fatalf("non-CGO authoring = %#v, err=%v", before.ItemAuthoring, err)
	}
	if err = engine.Close(); err != nil {
		t.Fatal(err)
	}
	removeSQLiteFiles(config.IndexPath())
	rebuilt, err := NewEngine(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer rebuilt.Close()
	after, err := rebuilt.Query(t.Context(), Query{Kind: QueryItemAuthoring, ElementID: item.ID})
	if err != nil || after.ItemAuthoring == nil || after.ItemAuthoring.Prompt != before.ItemAuthoring.Prompt || after.ItemAuthoring.Answer != before.ItemAuthoring.Answer {
		t.Fatalf("non-CGO rebuilt authoring = %#v, err=%v", after.ItemAuthoring, err)
	}
}
