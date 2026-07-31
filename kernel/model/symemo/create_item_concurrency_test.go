// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package symemo

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestCreateItemSameIDRetryReconcilesOneAuthority(t *testing.T) {
	engine, config := newFixtureEngine(t)
	command := CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{
		ElementID: "20260731150000-retry01",
		Prompt:    "Question retained across response loss",
		Answer:    "Answer retained across response loss",
	}}

	first, err := engine.CreateElement(t.Context(), command)
	if err != nil {
		t.Fatal(err)
	}
	second, err := engine.CreateElement(t.Context(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first.Item == nil || second.Item == nil || first.Item.ContentRevision != second.Item.ContentRevision || first.Item.SortRank == nil || second.Item.SortRank == nil || *first.Item.SortRank != *second.Item.SortRank {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
	files := snapshotDirectoryFiles(t, config.ElementsRoot())
	if _, found := files[command.CreateItem.ElementID+".sme"]; !found {
		t.Fatalf("same-ID source missing: %v", files)
	}
	ranks, diagnostics := config.loadSortRanks()
	if len(diagnostics) != 0 || ranks[command.CreateItem.ElementID] != *first.Item.SortRank {
		t.Fatalf("same-ID ranks=%v diagnostics=%#v", ranks, diagnostics)
	}
}

func TestCreateItemConcurrentDoubleSubmissionCreatesOneItem(t *testing.T) {
	engine, config := newFixtureEngine(t)
	command := CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{
		ElementID: "20260731150100-concurr",
		Prompt:    "Concurrent question",
		Answer:    "Concurrent answer",
	}}

	const callers = 16
	results := make(chan CreateElementResult, callers)
	errors := make(chan error, callers)
	var ready sync.WaitGroup
	ready.Add(callers)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		go func() {
			ready.Done()
			<-start
			result, err := engine.CreateElement(t.Context(), command)
			results <- result
			errors <- err
		}()
	}
	ready.Wait()
	close(start)

	var revision string
	for i := 0; i < callers; i++ {
		result, err := <-results, <-errors
		if err != nil || result.Item == nil || !result.CreateAccepted || result.ReviewAccepted {
			t.Fatalf("caller %d result=%#v err=%v", i, result, err)
		}
		if revision == "" {
			revision = result.Item.ContentRevision
		} else if result.Item.ContentRevision != revision {
			t.Fatalf("caller %d revision=%q want=%q", i, result.Item.ContentRevision, revision)
		}
	}
	if _, err := os.Stat(filepath.Join(config.ElementsRoot(), command.CreateItem.ElementID+".sme")); err != nil {
		t.Fatal(err)
	}
	ranks, diagnostics := config.loadSortRanks()
	if len(diagnostics) != 0 {
		t.Fatalf("sort diagnostics = %#v", diagnostics)
	}
	if _, found := ranks[command.CreateItem.ElementID]; !found {
		t.Fatalf("created Item rank missing: %v", ranks)
	}
}

func TestCreateItemRepairsRootOnlyAndSortOnlyAuthority(t *testing.T) {
	t.Run("root only", func(t *testing.T) {
		config := copyFixtureWorkspace(t)
		installFixtureSchedulerConfig(t, config)
		item := supportedTestItem("20260731150200-root001", "Existing question", "Existing answer", "rev-v1-existing")
		writeTestJSON(t, filepath.Join(config.ElementsRoot(), item.ID+".sme"), item)
		engine, err := NewEngine(t.Context(), config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = engine.Close() })

		result, err := engine.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{ElementID: item.ID, Prompt: item.Payload.Prompt, Answer: item.Payload.Answer}})
		if err != nil || result.Item == nil || result.Item.SortRank == nil || result.Item.ContentRevision != item.Payload.Revision {
			t.Fatalf("root-only repair result=%#v err=%v", result, err)
		}
	})

	t.Run("sort only", func(t *testing.T) {
		config := copyFixtureWorkspace(t)
		installFixtureSchedulerConfig(t, config)
		elementID := "20260731150300-sort001"
		ranks, err := config.loadSortRanksForCreate()
		if err != nil {
			t.Fatal(err)
		}
		ranks[elementID] = 37
		writeTestJSON(t, filepath.Join(config.ElementsRoot(), ".siyuan", "sort.json"), ranks)
		engine, err := NewEngine(t.Context(), config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = engine.Close() })

		result, err := engine.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{ElementID: elementID, Prompt: "New question", Answer: "New answer"}})
		if err != nil || result.Item == nil || result.Item.SortRank == nil || *result.Item.SortRank != 37 {
			t.Fatalf("sort-only repair result=%#v err=%v", result, err)
		}
	})
}

func TestCreateItemRejectsInternalOrUnsupportedSameIDOwnership(t *testing.T) {
	for _, test := range []struct {
		name  string
		setup func(*testing.T, Config) string
	}{
		{name: "internal Item", setup: func(t *testing.T, config Config) string {
			child := supportedTestItem("20260731150400-child01", "Child question", "Child answer", "rev-v1-child")
			root := Element{Spec: SupportedElementSpec, ID: "20260731150401-parent1", Type: "concept", ProcessingState: "processed", PayloadSpec: SupportedPayloadSpec, Payload: ElementPayload{Kind: "outline"}, Children: []Element{child}}
			writeTestJSON(t, filepath.Join(config.ElementsRoot(), root.ID+".sme"), root)
			return child.ID
		}},
		{name: "Topic root", setup: func(t *testing.T, config Config) string {
			root := Element{Spec: SupportedElementSpec, ID: "20260731150500-topic01", Type: "topic", Title: "Owned", ProcessingState: "new", PayloadSpec: SupportedPayloadSpec, Payload: ElementPayload{Material: &TopicMaterial{Kind: "html", HTML: "<p>Owned</p>"}}}
			writeTestJSON(t, filepath.Join(config.ElementsRoot(), root.ID+".sme"), root)
			return root.ID
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := copyFixtureWorkspace(t)
			installFixtureSchedulerConfig(t, config)
			elementID := test.setup(t, config)
			engine, err := NewEngine(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = engine.Close() })
			before := snapshotDirectoryFiles(t, config.ElementsRoot())

			result, err := engine.CreateElement(t.Context(), CreateElementCommand{Kind: CreateElementCreateItem, CreateItem: CreateItemCommand{ElementID: elementID, Prompt: "Claim", Answer: "Rejected"}})
			if err == nil || result.CreateAccepted || !equalByteMaps(before, snapshotDirectoryFiles(t, config.ElementsRoot())) {
				t.Fatalf("ownership result=%#v err=%v", result, err)
			}
		})
	}
}

func supportedTestItem(elementID, prompt, answer, revision string) Element {
	return Element{Spec: SupportedElementSpec, ID: elementID, Type: "item", ProcessingState: "processed", PayloadSpec: SupportedPayloadSpec, Payload: ElementPayload{Kind: "qa", Prompt: prompt, Answer: answer, Revision: revision}}
}
