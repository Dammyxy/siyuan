// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package symemo

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateItemHasNoSchedulingOrHostSideEffects(t *testing.T) {
	engine, config := newFixtureEngine(t)
	beforeReviews := snapshotDirectoryFiles(t, config.ReviewsRoot())
	beforeScheduler := snapshotDirectoryFiles(t, config.SchedulerRoot)

	result, err := engine.CreateElement(t.Context(), CreateElementCommand{
		Kind: CreateElementCreateItem,
		CreateItem: CreateItemCommand{
			ElementID: "20260731140000-sidefx1",
			Prompt:    "Question with https://example.com/image.png",
			Answer:    "Answer with a literal asset reference",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.CreateAccepted || result.ReviewAccepted || result.EventID != "" || result.Item == nil {
		t.Fatalf("create result = %#v", result)
	}
	if !equalByteMaps(beforeReviews, snapshotDirectoryFiles(t, config.ReviewsRoot())) {
		t.Fatal("Item creation changed .smr authority")
	}
	if !equalByteMaps(beforeScheduler, snapshotDirectoryFiles(t, config.SchedulerRoot)) {
		t.Fatal("Item creation changed scheduler authority")
	}
	assertNoCreateItemHostSideEffects(t, config.StorageRoot)
}

func assertNoCreateItemHostSideEffects(t *testing.T, root string) {
	t.Helper()
	for relative := range snapshotDirectoryFiles(t, root) {
		slash := filepath.ToSlash(relative)
		lower := strings.ToLower(slash)
		if strings.HasSuffix(lower, ".sy") || strings.HasSuffix(lower, ".sya") {
			t.Fatalf("create produced host document file %s", slash)
		}
		for _, forbidden := range []string{"assets/", "history/", "sessions/", "sync-conflict", "operation", "journal"} {
			if strings.Contains(lower, forbidden) {
				t.Fatalf("create produced forbidden side-effect path %s", slash)
			}
		}
	}
}
