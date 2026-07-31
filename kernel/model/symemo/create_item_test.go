// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package symemo

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestCreateItemPersistsExactTopLevelQAContract(t *testing.T) {
	engine, config := newFixtureEngine(t)
	elementID := "20260731120000-item001"
	prompt := "  第一行问题\n\nSecond line?  "
	answer := "  第一行答案\n\nSecond answer.  "

	result, err := engine.CreateElement(t.Context(), CreateElementCommand{
		Kind:       CreateElementCreateItem,
		CreateItem: CreateItemCommand{ElementID: elementID, Prompt: prompt, Answer: answer},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.CreateAccepted || result.ReviewAccepted || result.EventID != "" || result.Retryable || result.Item == nil {
		t.Fatalf("create result = %#v", result)
	}
	if result.ElementID != elementID || result.Item.ElementID != elementID || result.Item.ProcessingState != "processed" || result.Item.LifecycleState != "pending" {
		t.Fatalf("created Item summary = %#v", result.Item)
	}
	if !strings.HasPrefix(result.Item.ContentRevision, "rev-v1-") || result.Item.SortRank == nil {
		t.Fatalf("created Item revision/rank = %#v", result.Item)
	}

	sourcePath := filepath.Join(config.ElementsRoot(), elementID+".sme")
	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err = json.Unmarshal(sourceBytes, &raw); err != nil {
		t.Fatal(err)
	}
	wantRootKeys := []string{"id", "payload", "payloadSpec", "processingState", "spec", "type"}
	gotRootKeys := sortedJSONKeys(raw)
	if !reflect.DeepEqual(gotRootKeys, wantRootKeys) {
		t.Fatalf("root keys = %v, want %v; source=%s", gotRootKeys, wantRootKeys, sourceBytes)
	}
	if _, found := raw["title"]; found {
		t.Fatalf("new Item persisted a title: %s", sourceBytes)
	}
	var source Element
	if err = json.Unmarshal(sourceBytes, &source); err != nil {
		t.Fatal(err)
	}
	if source.Spec != SupportedElementSpec || source.ID != elementID || source.Type != "item" || source.Title != "" || source.TitleRevision != "" || source.ProcessingState != "processed" || source.PayloadSpec != SupportedPayloadSpec {
		t.Fatalf("created root = %#v", source)
	}
	if source.Payload.Kind != "qa" || source.Payload.Prompt != prompt || source.Payload.Answer != answer || source.Payload.Revision != result.Item.ContentRevision || source.Payload.Material != nil || len(source.Relations) != 0 || len(source.Children) != 0 {
		t.Fatalf("created payload = %#v", source.Payload)
	}
	var payload map[string]json.RawMessage
	if err = json.Unmarshal(raw["payload"], &payload); err != nil {
		t.Fatal(err)
	}
	wantPayloadKeys := []string{"answer", "kind", "prompt", "revision"}
	if got := sortedJSONKeys(payload); !reflect.DeepEqual(got, wantPayloadKeys) {
		t.Fatalf("payload keys = %v, want %v", got, wantPayloadKeys)
	}
}

func TestCreateItemRejectsInvalidIdentityOrWhitespaceContentWithoutWrites(t *testing.T) {
	for _, test := range []struct {
		name    string
		command CreateItemCommand
	}{
		{name: "invalid id", command: CreateItemCommand{ElementID: "not-a-node-id", Prompt: "Question", Answer: "Answer"}},
		{name: "blank prompt", command: CreateItemCommand{ElementID: "20260731120100-blankqp", Prompt: " \t\r\n", Answer: "Answer"}},
		{name: "blank answer", command: CreateItemCommand{ElementID: "20260731120200-blankqa", Prompt: "Question", Answer: "\u00a0\t\n"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine, config := newFixtureEngine(t)
			beforeElements := snapshotDirectoryFiles(t, config.ElementsRoot())
			beforeReviews := snapshotDirectoryFiles(t, config.ReviewsRoot())

			result, err := engine.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: test.command})
			if !hasCode(err, ErrInvalidCreateCommand) || result.CreateAccepted || result.ReviewAccepted {
				t.Fatalf("invalid create result=%#v err=%v", result, err)
			}
			if !equalByteMaps(beforeElements, snapshotDirectoryFiles(t, config.ElementsRoot())) || !equalByteMaps(beforeReviews, snapshotDirectoryFiles(t, config.ReviewsRoot())) {
				t.Fatal("invalid create changed source authority")
			}
		})
	}
}

func TestCreateItemOneHundredValidCreatesHaveFreshRevisionsAndDeterministicRanks(t *testing.T) {
	engine, config := newFixtureEngine(t)
	beforeReviews := snapshotDirectoryFiles(t, config.ReviewsRoot())
	seenRevisions := map[string]bool{}
	previousRank := -1

	for fixture := 0; fixture < 100; fixture++ {
		elementID := fmt.Sprintf("2026073113%04d-i%06d", fixture, fixture)
		result, err := engine.CreateElement(t.Context(), CreateElementCommand{
			Kind: CreateElementCreateItem,
			CreateItem: CreateItemCommand{
				ElementID: elementID,
				Prompt:    fmt.Sprintf("Question %03d\n保留内容", fixture),
				Answer:    fmt.Sprintf("Answer %03d\n保留内容", fixture),
			},
		})
		if err != nil {
			t.Fatalf("fixture %d: %v", fixture, err)
		}
		if result.Item == nil || result.Item.SortRank == nil || *result.Item.SortRank != previousRank+1 {
			t.Fatalf("fixture %d rank/result = %#v, previous=%d", fixture, result, previousRank)
		}
		previousRank = *result.Item.SortRank
		if result.Item.ContentRevision == "" || seenRevisions[result.Item.ContentRevision] {
			t.Fatalf("fixture %d revision = %q", fixture, result.Item.ContentRevision)
		}
		seenRevisions[result.Item.ContentRevision] = true
	}
	if got := len(seenRevisions); got != 100 {
		t.Fatalf("fresh revisions = %d", got)
	}
	if !equalByteMaps(beforeReviews, snapshotDirectoryFiles(t, config.ReviewsRoot())) {
		t.Fatal("100 Item creates changed review authority")
	}
}

func sortedJSONKeys(values map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
