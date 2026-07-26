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
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChangeElementAcceptedProjectionFailureReturnsAcceptedChangeAndRecovers(t *testing.T) {
	engine, config := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725064000-projacc", "20260725064001-projaev", "Original", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)
	stableID := firstTopicNodeID(t, detail.Payload.Material.HTML)
	restoreProjection := installProjectionRefreshFailure(t, engine, config)

	result, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                created.ElementID,
			ExpectedMaterialRevision: detail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + stableID + `">Accepted despite projection</p>`,
		},
	})
	domainErr, ok := AsDomainError(err)
	if !ok || domainErr.Code != ErrProjectionRefreshFailed || !domainErr.ChangeAccepted || domainErr.AcceptedChange == nil || domainErr.AcceptedChange.CanonicalValue != result.CanonicalValue || !result.ChangeAccepted {
		t.Fatalf("accepted projection failure result=%#v err=%#v", result, domainErr)
	}
	if _, queryErr := engine.Query(context.Background(), Query{Kind: QueryCurrentSession}); !hasCode(queryErr, ErrProjectionRebuildFailed) {
		t.Fatalf("accepted projection failure did not latch Engine unavailable: %v", queryErr)
	}
	source := readOptionalFile(t, filepath.Join(config.ElementsRoot(), created.ElementID+".sme"))
	if !strings.Contains(string(source), "Accepted despite projection") {
		t.Fatalf("accepted authority missing after projection failure: %s", source)
	}

	restoreProjection()
	if err = engine.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := NewEngine(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recovered.Close() })
	after := queryFeature006Element(t, recovered, created.ElementID)
	if after.Payload.Material.HTML != result.CanonicalValue || after.Payload.Material.Revision != result.Revision {
		t.Fatalf("recovered accepted change = %#v", after)
	}
}

func TestChangeElementReplacementErrorClassification(t *testing.T) {
	t.Run("proven zero write remains retryable", func(t *testing.T) {
		engine, _ := newFixtureEngine(t)
		created := createFeature006Topic(t, engine, "20260725064100-zerowri", "20260725064101-zerowre", "Original", "<p>Body</p>")
		detail := queryFeature006Element(t, engine, created.ElementID)
		restore := withChangeElementRootWriteFault(t, func(string, []byte) error {
			return errors.New("injected pre-acceptance write failure")
		})
		defer restore()

		_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementRenameElement,
			RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "Zero Write",
			},
		})
		domainErr, ok := AsDomainError(err)
		if !ok || domainErr.Code != ErrDurableWriteFailed || !domainErr.Retryable || domainErr.ChangeAccepted {
			t.Fatalf("zero-write classification = %#v", domainErr)
		}
		if _, err = engine.Query(context.Background(), Query{Kind: QueryCurrentSession}); err != nil {
			t.Fatalf("zero-write failure latched Engine: %v", err)
		}
	})

	t.Run("written bytes despite error are accepted", func(t *testing.T) {
		engine, _ := newFixtureEngine(t)
		created := createFeature006Topic(t, engine, "20260725064200-accwrit", "20260725064201-accwrie", "Original", "<p>Body</p>")
		detail := queryFeature006Element(t, engine, created.ElementID)
		restore := withChangeElementRootWriteFault(t, func(path string, data []byte) error {
			if err := os.WriteFile(path, data, 0644); err != nil {
				return err
			}
			return errors.New("reported after accepted replacement")
		})
		defer restore()

		result, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementRenameElement,
			RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "Accepted Write",
			},
		})
		if err != nil || !result.ChangeAccepted || !result.Changed {
			t.Fatalf("accepted write classification result=%#v err=%v", result, err)
		}
	})

	t.Run("indeterminate bytes latch unavailable without retry", func(t *testing.T) {
		engine, _ := newFixtureEngine(t)
		created := createFeature006Topic(t, engine, "20260725064300-partial", "20260725064301-partiae", "Original", "<p>Body</p>")
		detail := queryFeature006Element(t, engine, created.ElementID)
		restore := withChangeElementRootWriteFault(t, func(path string, data []byte) error {
			if err := os.WriteFile(path, []byte(`{"spec":1,"id":"20260725064300-partial","type":"topic","title":"Ambiguous"`), 0644); err != nil {
				return err
			}
			return errors.New("reported after indeterminate replacement")
		})
		defer restore()

		result, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementRenameElement,
			RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "Ambiguous",
			},
		})
		domainErr, ok := AsDomainError(err)
		if !ok || domainErr.Code != ErrElementWritePartial || domainErr.Retryable || domainErr.ChangeAccepted || result.ChangeAccepted {
			t.Fatalf("partial classification result=%#v err=%#v", result, domainErr)
		}
		if _, queryErr := engine.Query(context.Background(), Query{Kind: QueryCurrentSession}); !hasCode(queryErr, ErrProjectionRebuildFailed) {
			t.Fatalf("partial write did not latch Engine unavailable: %v", queryErr)
		}
	})
}
