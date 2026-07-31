// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package symemo

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateItemClassifiesZeroAndPartialAuthorityFailures(t *testing.T) {
	for _, test := range []struct {
		name         string
		stage        string
		wantCode     ErrorCode
		wantRoot     bool
		wantSortRank bool
	}{
		{name: "before root", stage: "before-root", wantCode: ErrDurableWriteFailed},
		{name: "after root", stage: "root", wantCode: ErrElementWritePartial, wantRoot: true},
		{name: "after sort", stage: "sort", wantCode: ErrElementWritePartial, wantRoot: true, wantSortRank: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine, config := newFixtureEngine(t)
			elementID := "20260731151000-fault01"
			restore := withCreateHTMLTopicAuthorityFault(t, test.stage, errors.New("injected "+test.stage+" failure"))
			defer restore()

			result, err := engine.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{ElementID: elementID, Prompt: "Question", Answer: "Answer"}})
			domainErr, ok := AsDomainError(err)
			if !ok || domainErr.Code != test.wantCode || domainErr.CreateAccepted || domainErr.ReviewAccepted || result.CreateAccepted || result.ReviewAccepted {
				t.Fatalf("failure result=%#v err=%#v", result, domainErr)
			}
			_, statErr := os.Stat(filepath.Join(config.ElementsRoot(), elementID+".sme"))
			if (statErr == nil) != test.wantRoot {
				t.Fatalf("root exists=%v want=%v err=%v", statErr == nil, test.wantRoot, statErr)
			}
			ranks, diagnostics := config.loadSortRanks()
			if len(diagnostics) != 0 {
				t.Fatalf("sort diagnostics = %#v", diagnostics)
			}
			_, found := ranks[elementID]
			if found != test.wantSortRank {
				t.Fatalf("sort rank exists=%v want=%v", found, test.wantSortRank)
			}
		})
	}
}

func TestCreateItemProjectionFailureReportsAcceptedContentOnlyCreate(t *testing.T) {
	engine, config := newFixtureEngine(t)
	elementID := "20260731151100-proj001"
	restoreProjection := installProjectionRefreshFailure(t, engine, config)

	result, err := engine.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{ElementID: elementID, Prompt: "Accepted question", Answer: "Accepted answer"}})
	domainErr, ok := AsDomainError(err)
	if !ok || domainErr.Code != ErrProjectionRefreshFailed || !domainErr.Retryable || !domainErr.CreateAccepted || domainErr.ReviewAccepted || domainErr.EventID != "" || !result.CreateAccepted || result.ReviewAccepted || result.EventID != "" {
		t.Fatalf("accepted failure result=%#v err=%#v", result, domainErr)
	}
	rootPath := filepath.Join(config.ElementsRoot(), elementID+".sme")
	if _, statErr := os.Stat(rootPath); statErr != nil {
		t.Fatalf("accepted root missing: %v", statErr)
	}
	rootBefore := readOptionalFile(t, rootPath)
	sortPath := filepath.Join(config.ElementsRoot(), ".siyuan", "sort.json")
	sortBefore := readOptionalFile(t, sortPath)
	if _, queryErr := engine.Query(t.Context(), Query{Kind: QueryCurrentSession}); !hasCode(queryErr, ErrProjectionRebuildFailed) {
		t.Fatalf("accepted projection failure did not latch Engine: %v", queryErr)
	}

	restoreProjection()
	if err = engine.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := NewEngine(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recovered.Close() })
	previousFault := createHTMLTopicAuthorityFault
	writeStages := 0
	createHTMLTopicAuthorityFault = func(string) error {
		writeStages++
		return errors.New("same-ID reconciliation attempted a second authority write")
	}
	t.Cleanup(func() { createHTMLTopicAuthorityFault = previousFault })
	reconciled, err := recovered.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{ElementID: elementID, Prompt: "Accepted question", Answer: "Accepted answer"}})
	if err != nil || reconciled.Item == nil || !reconciled.CreateAccepted || reconciled.ReviewAccepted {
		t.Fatalf("reconciled result=%#v err=%v", reconciled, err)
	}
	if writeStages != 0 || !bytes.Equal(readOptionalFile(t, rootPath), rootBefore) || !bytes.Equal(readOptionalFile(t, sortPath), sortBefore) {
		t.Fatalf("same-ID reconciliation rewrote authority: stages=%d", writeStages)
	}
}
