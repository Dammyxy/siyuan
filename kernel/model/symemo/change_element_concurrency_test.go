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

package symemo

import (
	"context"
	"sync"
	"testing"
)

func TestChangeElementConcurrentDifferentFieldsPreserveBothValues(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725063000-concura", "20260725063001-concure", "Original", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)
	stableID := firstTopicNodeID(t, detail.Payload.Material.HTML)

	var wg sync.WaitGroup
	wg.Add(2)
	errs := make(chan error, 2)
	go func() {
		defer wg.Done()
		_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementRenameElement,
			RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "Concurrent Title",
			},
		})
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementSaveTopicHTML,
			SaveTopicHTML: SaveTopicHTMLCommand{
				ElementID:                created.ElementID,
				ExpectedMaterialRevision: detail.Payload.Material.Revision,
				HTML:                     `<p data-symemo-node-id="` + stableID + `">Concurrent Body</p>`,
			},
		})
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	after := queryFeature006Element(t, engine, created.ElementID)
	if after.Title != "Concurrent Title" || after.Payload.Material.HTML != `<p data-symemo-node-id="`+stableID+`">Concurrent Body</p>` {
		t.Fatalf("concurrent different-field result = %#v", after)
	}
}

func TestChangeElementConcurrentSameFieldAllowsOneWinner(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725063100-samefie", "20260725063101-samefiv", "Original", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)
	stableID := firstTopicNodeID(t, detail.Payload.Material.HTML)

	errs := make(chan error, 2)
	for _, body := range []string{"First", "Second"} {
		body := body
		go func() {
			_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
				Kind: ChangeElementSaveTopicHTML,
				SaveTopicHTML: SaveTopicHTMLCommand{
					ElementID:                created.ElementID,
					ExpectedMaterialRevision: detail.Payload.Material.Revision,
					HTML:                     `<p data-symemo-node-id="` + stableID + `">` + body + `</p>`,
				},
			})
			errs <- err
		}()
	}
	var successes, conflicts int
	for i := 0; i < 2; i++ {
		err := <-errs
		if err == nil {
			successes++
			continue
		}
		if hasCode(err, ErrElementRevisionConflict) {
			conflicts++
			continue
		}
		t.Fatalf("unexpected same-field error = %v", err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestSaveItemQAConcurrentDifferentPairsAllowOneAggregateWinner(t *testing.T) {
	engine, _, item := newItemAuthorityEngine(t, supportedTestItem("20260731161000-qaconcr", "Original prompt", "Original answer", "rev-v1-original"))

	errs := make(chan error, 2)
	results := make(chan ChangeElementResult, 2)
	for _, pair := range [][2]string{{"First prompt", "First answer"}, {"Second prompt", "Second answer"}} {
		pair := pair
		go func() {
			result, err := engine.ChangeElement(t.Context(), ChangeElementCommand{Kind: ChangeElementSaveItemQA, SaveItemQA: SaveItemQACommand{
				ElementID: item.ID, ExpectedContentRevision: item.Payload.Revision, Prompt: pair[0], Answer: pair[1],
			}})
			results <- result
			errs <- err
		}()
	}
	var successes, conflicts int
	for i := 0; i < 2; i++ {
		result, err := <-results, <-errs
		if err == nil {
			if !result.ChangeAccepted || !result.Changed || result.ItemQA == nil {
				t.Fatalf("successful result = %#v", result)
			}
			successes++
			continue
		}
		if hasCode(err, ErrElementRevisionConflict) {
			conflicts++
			continue
		}
		t.Fatalf("unexpected concurrent result=%#v err=%v", result, err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}
