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
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
)

func TestChangeElementRenameAndSavePreserveAuthorityAndIndependentRevisions(t *testing.T) {
	engine, config := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725061000-authora", "20260725061001-authore", "Original", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)
	titleRevision := detail.TitleRevision
	materialRevision := detail.Payload.Material.Revision
	if titleRevision == "" || materialRevision == "" || titleRevision == materialRevision {
		t.Fatalf("initial revisions title=%q material=%q", titleRevision, materialRevision)
	}
	beforeSort := readOptionalFile(t, filepath.Join(config.ElementsRoot(), ".siyuan", "sort.json"))
	beforeReviews := snapshotDirectoryFiles(t, config.ReviewsRoot())
	beforeScheduler := snapshotDirectoryFiles(t, config.SchedulerRoot)

	renamed, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementRenameElement,
		RenameElement: RenameElementCommand{
			ElementID:             created.ElementID,
			ExpectedTitleRevision: titleRevision,
			Title:                 "  New/Name  ",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Kind != ChangeElementRenameElement || renamed.ChangedField != ChangedElementTitle || renamed.CanonicalValue != "New/Name" || !renamed.Changed || !renamed.ChangeAccepted || renamed.Revision == titleRevision {
		t.Fatalf("rename result = %#v", renamed)
	}

	afterRename := queryFeature006Element(t, engine, created.ElementID)
	if afterRename.Title != "New/Name" || afterRename.TitleRevision != renamed.Revision || afterRename.Payload.Material.HTML != detail.Payload.Material.HTML || afterRename.Payload.Material.Revision != materialRevision {
		t.Fatalf("after rename detail = %#v", afterRename)
	}
	stableID := firstTopicNodeID(t, afterRename.Payload.Material.HTML)
	clientKey := "client-v1-20260725061100-0123456789abcdefABCDEF"
	saved, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                created.ElementID,
			ExpectedMaterialRevision: materialRevision,
			HTML:                     `<p data-symemo-node-id="` + stableID + `">Edited</p><p data-symemo-client-node-key="` + clientKey + `">New</p>`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Kind != ChangeElementSaveTopicHTML || saved.ChangedField != ChangedElementMaterial || saved.CleaningPolicyVersion != topicHTMLCleaningPolicyVersion || !saved.Changed || !saved.ChangeAccepted || saved.Revision == materialRevision {
		t.Fatalf("save result = %#v", saved)
	}
	if len(saved.NodeIdentityAssignments) != 1 || saved.NodeIdentityAssignments[0].ClientNodeKey != clientKey || !ast.IsNodeIDPattern(saved.NodeIdentityAssignments[0].NodeID) {
		t.Fatalf("identity assignments = %#v", saved.NodeIdentityAssignments)
	}
	if strings.Contains(saved.CanonicalValue, "client-node-key") || !strings.Contains(saved.CanonicalValue, saved.NodeIdentityAssignments[0].NodeID) {
		t.Fatalf("canonical saved HTML = %s assignments=%#v", saved.CanonicalValue, saved.NodeIdentityAssignments)
	}

	afterSave := queryFeature006Element(t, engine, created.ElementID)
	if afterSave.Title != "New/Name" || afterSave.TitleRevision != renamed.Revision || afterSave.Payload.Material.HTML != saved.CanonicalValue || afterSave.Payload.Material.Revision != saved.Revision {
		t.Fatalf("after save detail = %#v", afterSave)
	}
	noop, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementRenameElement,
		RenameElement: RenameElementCommand{
			ElementID:             created.ElementID,
			ExpectedTitleRevision: "stale-title-revision",
			Title:                 "New/Name",
		},
	})
	if err != nil || noop.Changed || noop.Revision != renamed.Revision || !noop.ChangeAccepted {
		t.Fatalf("stale no-op result=%#v err=%v", noop, err)
	}

	if afterSort := readOptionalFile(t, filepath.Join(config.ElementsRoot(), ".siyuan", "sort.json")); string(afterSort) != string(beforeSort) {
		t.Fatal("title/body change modified sort authority")
	}
	if afterReviews := snapshotDirectoryFiles(t, config.ReviewsRoot()); !equalByteMaps(beforeReviews, afterReviews) {
		t.Fatal("title/body change modified review history")
	}
	if afterScheduler := snapshotDirectoryFiles(t, config.SchedulerRoot); !equalByteMaps(beforeScheduler, afterScheduler) {
		t.Fatal("title/body change modified scheduler authority")
	}
	source := readOptionalFile(t, filepath.Join(config.ElementsRoot(), created.ElementID+".sme"))
	if !strings.Contains(string(source), `"title": "New/Name"`) || !strings.Contains(string(source), `"titleRevision":`) || !strings.Contains(string(source), `"revision":`) || strings.Contains(string(source), "client-node-key") {
		t.Fatalf("source did not persist explicit authoring authority: %s", source)
	}
}

func TestChangeElementInternalTopicPreservesUnknownFieldsAndLegacyRevisions(t *testing.T) {
	config := copyFixtureWorkspace(t)
	installFixtureSchedulerConfig(t, config)
	fixture, err := os.ReadFile(filepath.Join("testdata", "elements", "20260725060000-feat006.sme"))
	if err != nil {
		t.Fatal(err)
	}
	rootPath := filepath.Join(config.ElementsRoot(), "20260725060000-feat006.sme")
	if err = os.WriteFile(rootPath, fixture, 0644); err != nil {
		t.Fatal(err)
	}
	engine, err := NewEngine(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	const childID = "20260725060002-childaa"
	child := queryFeature006Element(t, engine, childID)
	if child.StorageKind != StorageKindInternal || child.RootElementID != "20260725060000-feat006" || child.TitleRevision == "" || child.Payload.Material.Revision == "" {
		t.Fatalf("child legacy detail = %#v", child)
	}
	before, err := os.ReadFile(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                childID,
			ExpectedMaterialRevision: child.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="20260725060003-nodeaaa">Child edited</p>`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !saved.Changed || saved.Revision == child.Payload.Material.Revision {
		t.Fatalf("internal save result = %#v", saved)
	}
	if _, err = os.Stat(filepath.Join(config.ElementsRoot(), childID+".sme")); !os.IsNotExist(err) {
		t.Fatalf("internal mutation created child root file: %v", err)
	}
	after, err := os.ReadFile(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) == string(before) {
		t.Fatal("internal mutation did not replace owning root")
	}
	assertRawJSONPath(t, after, []string{"futureRoot"}, "kept-root")
	assertRawJSONPath(t, after, []string{"payload", "futurePayload"}, "kept-root-payload")
	assertRawJSONPath(t, after, []string{"children", "0", "futureChild"}, "kept-child")
	assertRawJSONPath(t, after, []string{"children", "0", "payload", "futurePayload"}, "kept-child-payload")
	assertRawJSONPath(t, after, []string{"children", "0", "payload", "material", "futureMaterial"}, "kept-child-material")

	conflict, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                childID,
			ExpectedMaterialRevision: child.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="20260725060003-nodeaaa">Conflict</p>`,
		},
	})
	domainErr, ok := AsDomainError(err)
	if !ok || domainErr.Code != ErrElementRevisionConflict || domainErr.ChangeAccepted || domainErr.ChangedField != ChangedElementMaterial || domainErr.CurrentRevision != saved.Revision || conflict.ChangeAccepted {
		t.Fatalf("same-field conflict result=%#v err=%#v", conflict, domainErr)
	}
	afterConflict, err := os.ReadFile(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterConflict) != string(after) {
		t.Fatal("conflict changed owning root bytes")
	}

	renamed, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementRenameElement,
		RenameElement: RenameElementCommand{
			ElementID:             childID,
			ExpectedTitleRevision: child.TitleRevision,
			Title:                 "Child Renamed",
		},
	})
	if err != nil || !renamed.Changed {
		t.Fatalf("different-field legacy rename result=%#v err=%v", renamed, err)
	}
}

func TestChangeElementRejectsInvalidTitlesUnsupportedTargetsAndMalformedCommands(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725062000-invalid", "20260725062001-invalie", "Original", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)

	for _, test := range []struct {
		name    string
		command ChangeElementCommand
		code    ErrorCode
	}{
		{
			name: "title line break",
			command: ChangeElementCommand{Kind: ChangeElementRenameElement, RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "bad\nname",
			}},
			code: ErrInvalidElementTitle,
		},
		{
			name: "missing variant",
			command: ChangeElementCommand{
				Kind: ChangeElementRenameElement,
			},
			code: ErrInvalidChangeCommand,
		},
		{
			name: "missing save variant",
			command: ChangeElementCommand{
				Kind: ChangeElementSaveTopicHTML,
			},
			code: ErrInvalidChangeCommand,
		},
		{
			name: "extra variant",
			command: ChangeElementCommand{
				Kind: ChangeElementRenameElement,
				RenameElement: RenameElementCommand{
					ElementID:             created.ElementID,
					ExpectedTitleRevision: detail.TitleRevision,
					Title:                 "Valid",
				},
				SaveTopicHTML: SaveTopicHTMLCommand{
					ElementID:                created.ElementID,
					ExpectedMaterialRevision: detail.Payload.Material.Revision,
					HTML:                     "<p>Body</p>",
				},
			},
			code: ErrInvalidChangeCommand,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := engine.ChangeElement(context.Background(), test.command); !hasCode(err, test.code) {
				t.Fatalf("change error = %v, want %s", err, test.code)
			}
		})
	}
}

func TestChangeElementPlansFromLatestRootBytes(t *testing.T) {
	t.Run("stale scan cannot overwrite newer title revision", func(t *testing.T) {
		engine, config := newFixtureEngine(t)
		created := createFeature006Topic(t, engine, "20260725066300-latestt", "20260725066301-lateste", "Original", "<p>Body</p>")
		detail := queryFeature006Element(t, engine, created.ElementID)
		rootPath := filepath.Join(config.ElementsRoot(), created.ElementID+".sme")
		latest := Element{
			Spec:            SupportedElementSpec,
			ID:              created.ElementID,
			Type:            "topic",
			Title:           "Externally Latest",
			TitleRevision:   "rev-v1-external-title",
			ProcessingState: "new",
			PayloadSpec:     SupportedPayloadSpec,
			Payload: ElementPayload{Material: &TopicMaterial{
				Kind:                  "html",
				HTML:                  detail.Payload.Material.HTML,
				CleaningPolicyVersion: topicHTMLCleaningPolicyVersion,
				Revision:              detail.Payload.Material.Revision,
			}},
		}
		interleaved := false
		var latestBytes []byte
		previousRead := readChangeElementRootFile
		readChangeElementRootFile = func(path string) ([]byte, error) {
			if filepath.Clean(path) == filepath.Clean(rootPath) && !interleaved {
				interleaved = true
				writeTestJSON(t, rootPath, latest)
				latestBytes = readOptionalFile(t, rootPath)
			}
			return os.ReadFile(path)
		}
		t.Cleanup(func() { readChangeElementRootFile = previousRead })

		result, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementRenameElement,
			RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "Local Stale",
			},
		})
		domainErr, ok := AsDomainError(err)
		if !ok || domainErr.Code != ErrElementRevisionConflict || domainErr.ChangedField != ChangedElementTitle || domainErr.CurrentRevision != latest.TitleRevision || result.ChangeAccepted {
			t.Fatalf("stale latest-root conflict result=%#v err=%#v", result, domainErr)
		}
		if after := readOptionalFile(t, rootPath); string(after) != string(latestBytes) {
			t.Fatalf("stale command rewrote latest authority:\nlatest=%s\nafter=%s", latestBytes, after)
		}
	})

	t.Run("latest no-op returns latest revision despite stale expected revision", func(t *testing.T) {
		engine, config := newFixtureEngine(t)
		created := createFeature006Topic(t, engine, "20260725066400-latenop", "20260725066401-latenoe", "Original", "<p>Body</p>")
		detail := queryFeature006Element(t, engine, created.ElementID)
		rootPath := filepath.Join(config.ElementsRoot(), created.ElementID+".sme")
		latest := Element{
			Spec:            SupportedElementSpec,
			ID:              created.ElementID,
			Type:            "topic",
			Title:           "Already Applied",
			TitleRevision:   "rev-v1-latest-noop-title",
			ProcessingState: "new",
			PayloadSpec:     SupportedPayloadSpec,
			Payload: ElementPayload{Material: &TopicMaterial{
				Kind:                  "html",
				HTML:                  detail.Payload.Material.HTML,
				CleaningPolicyVersion: topicHTMLCleaningPolicyVersion,
				Revision:              detail.Payload.Material.Revision,
			}},
		}
		interleaved := false
		var latestBytes []byte
		previousRead := readChangeElementRootFile
		readChangeElementRootFile = func(path string) ([]byte, error) {
			if filepath.Clean(path) == filepath.Clean(rootPath) && !interleaved {
				interleaved = true
				writeTestJSON(t, rootPath, latest)
				latestBytes = readOptionalFile(t, rootPath)
			}
			return os.ReadFile(path)
		}
		t.Cleanup(func() { readChangeElementRootFile = previousRead })

		result, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
			Kind: ChangeElementRenameElement,
			RenameElement: RenameElementCommand{
				ElementID:             created.ElementID,
				ExpectedTitleRevision: detail.TitleRevision,
				Title:                 "Already Applied",
			},
		})
		if err != nil || result.Changed || !result.ChangeAccepted || result.Revision != latest.TitleRevision || result.CanonicalValue != latest.Title {
			t.Fatalf("latest no-op result=%#v err=%v", result, err)
		}
		if after := readOptionalFile(t, rootPath); string(after) != string(latestBytes) {
			t.Fatalf("latest no-op rewrote authority:\nlatest=%s\nafter=%s", latestBytes, after)
		}
	})
}

func TestChangeElementMaterialIdentityPolicyAndDeterministicKeyRetry(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	first := createFeature006Topic(t, engine, "20260725066000-identaa", "20260725066001-identae", "First", "<p>First</p>")
	second := createFeature006Topic(t, engine, "20260725066002-identbb", "20260725066003-identbe", "Second", "<p>Second</p>")
	firstDetail := queryFeature006Element(t, engine, first.ElementID)
	secondDetail := queryFeature006Element(t, engine, second.ElementID)
	firstNodeID := firstTopicNodeID(t, firstDetail.Payload.Material.HTML)
	secondNodeID := firstTopicNodeID(t, secondDetail.Payload.Material.HTML)

	if _, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                first.ElementID,
			ExpectedMaterialRevision: firstDetail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + secondNodeID + `">Foreign</p>`,
		},
	}); !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("foreign stable ID error = %v", err)
	}
	if _, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                first.ElementID,
			ExpectedMaterialRevision: firstDetail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + firstNodeID + `">One</p><p data-symemo-node-id="` + firstNodeID + `">Two</p>`,
		},
	}); !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("duplicate stable ID error = %v", err)
	}

	clientKey := "client-v1-20260725066100-ZYXWVUTSRQPONMLKJIHGFE"
	keyedHTML := `<p data-symemo-node-id="` + firstNodeID + `">First edited</p><p data-symemo-client-node-key="` + clientKey + `">Keyed</p>`
	accepted, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                first.ElementID,
			ExpectedMaterialRevision: firstDetail.Payload.Material.Revision,
			HTML:                     keyedHTML,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(accepted.NodeIdentityAssignments) != 1 || accepted.NodeIdentityAssignments[0].ClientNodeKey != clientKey {
		t.Fatalf("accepted keyed assignment = %#v", accepted.NodeIdentityAssignments)
	}
	retry, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                first.ElementID,
			ExpectedMaterialRevision: "stale-after-lost-response",
			HTML:                     keyedHTML,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != accepted.Revision || len(retry.NodeIdentityAssignments) != 1 || retry.NodeIdentityAssignments[0].NodeID != accepted.NodeIdentityAssignments[0].NodeID {
		t.Fatalf("keyed no-op retry = %#v accepted=%#v", retry, accepted)
	}
}

func TestChangeElementRejectsGloballyAmbiguousCurrentStableNodeID(t *testing.T) {
	engine, config := newFixtureEngine(t)
	first := createFeature006Topic(t, engine, "20260725066500-global1", "20260725066501-globae1", "First", "<p>First</p>")
	second := createFeature006Topic(t, engine, "20260725066502-global2", "20260725066503-globae2", "Second", "<p>Second</p>")
	firstDetail := queryFeature006Element(t, engine, first.ElementID)
	secondDetail := queryFeature006Element(t, engine, second.ElementID)
	firstNodeID := firstTopicNodeID(t, firstDetail.Payload.Material.HTML)
	secondPath := filepath.Join(config.ElementsRoot(), second.ElementID+".sme")
	writeTestJSON(t, secondPath, Element{
		Spec:            SupportedElementSpec,
		ID:              second.ElementID,
		Type:            "topic",
		Title:           secondDetail.Title,
		TitleRevision:   secondDetail.TitleRevision,
		ProcessingState: "new",
		PayloadSpec:     SupportedPayloadSpec,
		Payload: ElementPayload{Material: &TopicMaterial{
			Kind:                  "html",
			HTML:                  `<p data-symemo-node-id="` + firstNodeID + `">Second stole ID</p>`,
			CleaningPolicyVersion: topicHTMLCleaningPolicyVersion,
			Revision:              secondDetail.Payload.Material.Revision,
		}},
	})

	_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                first.ElementID,
			ExpectedMaterialRevision: firstDetail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + firstNodeID + `">First edited</p>`,
		},
	})
	if !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("globally ambiguous current stable ID error = %v", err)
	}
}

func TestChangeElementRejectsLatestCrossTopicClientKeyCollision(t *testing.T) {
	engine, config := newFixtureEngine(t)
	first := createFeature006Topic(t, engine, "20260725066600-gkeyone", "20260725066601-gkeye01", "First", "<p>First</p>")
	second := createFeature006Topic(t, engine, "20260725066602-gkeytwo", "20260725066603-gkeye02", "Second", "<p>Second</p>")
	firstDetail := queryFeature006Element(t, engine, first.ElementID)
	secondDetail := queryFeature006Element(t, engine, second.ElementID)
	firstNodeID := firstTopicNodeID(t, firstDetail.Payload.Material.HTML)
	clientKey := "client-v1-20260725066700-abcdefghijklmnopqrstuv"
	derivedNodeID := deriveTopicHTMLClientNodeID(first.ElementID, clientKey)
	secondPath := filepath.Join(config.ElementsRoot(), second.ElementID+".sme")
	firstPath := filepath.Join(config.ElementsRoot(), first.ElementID+".sme")

	interleaved := false
	previousRead := readChangeElementRootFile
	readChangeElementRootFile = func(path string) ([]byte, error) {
		if filepath.Clean(path) == filepath.Clean(firstPath) && !interleaved {
			interleaved = true
			writeTestJSON(t, secondPath, Element{
				Spec:            SupportedElementSpec,
				ID:              second.ElementID,
				Type:            "topic",
				Title:           secondDetail.Title,
				TitleRevision:   secondDetail.TitleRevision,
				ProcessingState: "new",
				PayloadSpec:     SupportedPayloadSpec,
				Payload: ElementPayload{Material: &TopicMaterial{
					Kind:                  "html",
					HTML:                  `<p data-symemo-node-id="` + derivedNodeID + `">Latest collision</p>`,
					CleaningPolicyVersion: topicHTMLCleaningPolicyVersion,
					Revision:              secondDetail.Payload.Material.Revision,
				}},
			})
		}
		return os.ReadFile(path)
	}
	t.Cleanup(func() { readChangeElementRootFile = previousRead })

	_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                first.ElementID,
			ExpectedMaterialRevision: firstDetail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + firstNodeID + `">First edited</p><p data-symemo-client-node-key="` + clientKey + `">New</p>`,
		},
	})
	if !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("latest client-key collision error = %v", err)
	}
}

func TestChangeElementRejectsMaterialSaveWhenGlobalOwnershipScanHasDiagnostics(t *testing.T) {
	engine, config := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725066300-diagown", "20260725066301-diagowe", "Target", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)
	stableID := firstTopicNodeID(t, detail.Payload.Material.HTML)
	if err := os.WriteFile(filepath.Join(config.ElementsRoot(), "20260725066302-brokenx.sme"), []byte(`{"id":`), 0644); err != nil {
		t.Fatal(err)
	}
	rootPath := filepath.Join(config.ElementsRoot(), created.ElementID+".sme")
	before := readOptionalFile(t, rootPath)

	_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                created.ElementID,
			ExpectedMaterialRevision: detail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + stableID + `">Edited</p>`,
		},
	})
	if !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("ownership diagnostic error = %v", err)
	}
	if after := readOptionalFile(t, rootPath); string(after) != string(before) {
		t.Fatal("diagnosed ownership scan changed target authority")
	}
}

func TestChangeElementRejectsMaterialSaveWhenAnyGlobalNodeOwnerIsAmbiguous(t *testing.T) {
	engine, config := newFixtureEngine(t)
	first := createFeature006Topic(t, engine, "20260725066800-ambig01", "20260725066801-ambige1", "First", "<p>First</p>")
	second := createFeature006Topic(t, engine, "20260725066802-ambig02", "20260725066803-ambige2", "Second", "<p>Second</p>")
	target := createFeature006Topic(t, engine, "20260725066804-ambig03", "20260725066805-ambige3", "Target", "<p>Target</p>")
	firstDetail := queryFeature006Element(t, engine, first.ElementID)
	secondDetail := queryFeature006Element(t, engine, second.ElementID)
	targetDetail := queryFeature006Element(t, engine, target.ElementID)
	duplicateID := firstTopicNodeID(t, firstDetail.Payload.Material.HTML)
	targetID := firstTopicNodeID(t, targetDetail.Payload.Material.HTML)
	writeTestJSON(t, filepath.Join(config.ElementsRoot(), second.ElementID+".sme"), Element{
		Spec:            SupportedElementSpec,
		ID:              second.ElementID,
		Type:            "topic",
		Title:           secondDetail.Title,
		TitleRevision:   secondDetail.TitleRevision,
		ProcessingState: "new",
		PayloadSpec:     SupportedPayloadSpec,
		Payload: ElementPayload{Material: &TopicMaterial{
			Kind:                  "html",
			HTML:                  `<p data-symemo-node-id="` + duplicateID + `">Duplicate</p>`,
			CleaningPolicyVersion: topicHTMLCleaningPolicyVersion,
			Revision:              secondDetail.Payload.Material.Revision,
		}},
	})

	_, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                target.ElementID,
			ExpectedMaterialRevision: targetDetail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + targetID + `">Edited target</p>`,
		},
	})
	if !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("ambiguous global owner error = %v", err)
	}
}

func TestChangeElementRejectsTargetRootChangedBetweenReadAndOwnershipScan(t *testing.T) {
	engine, config := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725066400-rootsna", "20260725066401-rootsne", "Original", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)
	stableID := firstTopicNodeID(t, detail.Payload.Material.HTML)
	rootPath := filepath.Join(config.ElementsRoot(), created.ElementID+".sme")
	oldBytes := readOptionalFile(t, rootPath)
	var external Element
	if err := json.Unmarshal(oldBytes, &external); err != nil {
		t.Fatal(err)
	}
	external.Title = "External title"
	external.TitleRevision = "rev-v1-external-title"
	externalBytes, err := json.MarshalIndent(external, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	externalBytes = append(externalBytes, '\n')

	previousRead := readChangeElementRootFile
	interleaved := false
	readChangeElementRootFile = func(path string) ([]byte, error) {
		data, readErr := os.ReadFile(path)
		if readErr == nil && filepath.Clean(path) == filepath.Clean(rootPath) && !interleaved {
			interleaved = true
			if writeErr := os.WriteFile(rootPath, externalBytes, 0644); writeErr != nil {
				t.Fatal(writeErr)
			}
		}
		return data, readErr
	}
	t.Cleanup(func() { readChangeElementRootFile = previousRead })

	_, err = engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                created.ElementID,
			ExpectedMaterialRevision: detail.Payload.Material.Revision,
			HTML:                     `<p data-symemo-node-id="` + stableID + `">Edited</p>`,
		},
	})
	if !hasCode(err, ErrElementSourceUnavailable) {
		t.Fatalf("changed target root error = %v", err)
	}
	if current := readOptionalFile(t, rootPath); string(current) != string(externalBytes) {
		t.Fatalf("changed target root was overwritten:\n%s", current)
	}
}

func TestQueryLegacyAuthoringRevisionsAreProjectionOnly(t *testing.T) {
	config := copyFixtureWorkspace(t)
	installFixtureSchedulerConfig(t, config)
	fixture, err := os.ReadFile(filepath.Join("testdata", "elements", "20260725060000-feat006.sme"))
	if err != nil {
		t.Fatal(err)
	}
	rootPath := filepath.Join(config.ElementsRoot(), "20260725060000-feat006.sme")
	if err = os.WriteFile(rootPath, fixture, 0644); err != nil {
		t.Fatal(err)
	}
	before := readOptionalFile(t, rootPath)
	engine, err := NewEngine(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	for _, elementID := range []string{"20260725060000-feat006", "20260725060002-childaa"} {
		detail := queryFeature006Element(t, engine, elementID)
		if !strings.HasPrefix(detail.TitleRevision, "legacy-v1-") || !strings.HasPrefix(detail.Payload.Material.Revision, "legacy-v1-") {
			t.Fatalf("legacy revisions for %s = title %q material %q", elementID, detail.TitleRevision, detail.Payload.Material.Revision)
		}
	}
	after := readOptionalFile(t, rootPath)
	if string(after) != string(before) {
		t.Fatal("legacy revision query wrote source authority")
	}
}

func TestChangeElementCanonicalEmptyMaterialAndHostileEmptyRejection(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	created := createFeature006Topic(t, engine, "20260725066200-emptyma", "20260725066201-emptyme", "Body", "<p>Body</p>")
	detail := queryFeature006Element(t, engine, created.ElementID)

	emptied, err := engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                created.ElementID,
			ExpectedMaterialRevision: detail.Payload.Material.Revision,
			HTML:                     `<p data-mce-bogus="1"><br></p>`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !emptied.Changed || emptied.CanonicalValue != "" {
		t.Fatalf("canonical empty save = %#v", emptied)
	}
	if _, err = engine.ChangeElement(context.Background(), ChangeElementCommand{
		Kind: ChangeElementSaveTopicHTML,
		SaveTopicHTML: SaveTopicHTMLCommand{
			ElementID:                created.ElementID,
			ExpectedMaterialRevision: emptied.Revision,
			HTML:                     `<script>bad()</script>`,
		},
	}); !hasCode(err, ErrInvalidTopicHTML) {
		t.Fatalf("hostile empty rejection = %v", err)
	}
}

func createFeature006Topic(t *testing.T, engine *Engine, elementID, eventID, title, html string) CreateElementResult {
	t.Helper()
	restoreIDs := withCreateHTMLTopicNodeIDs(t, elementID, eventID)
	defer restoreIDs()
	result, err := engine.CreateElement(context.Background(), CreateElementCommand{
		Kind: CreateElementAddNewTopic,
		AddNewTopic: AddNewTopicCommand{
			Title: title,
			HTML:  html,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func queryFeature006Element(t *testing.T, engine *Engine, elementID string) *ElementReadView {
	t.Helper()
	result, err := engine.Query(context.Background(), Query{Kind: QueryElement, ElementID: elementID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Element == nil || result.Element.Payload.Material == nil {
		t.Fatalf("missing Element detail for %s: %#v", elementID, result.Element)
	}
	return result.Element
}

func firstTopicNodeID(t *testing.T, html string) string {
	t.Helper()
	match := feature004NodeIDPattern.FindString(html)
	if match == "" {
		t.Fatalf("HTML has no stable node ID: %s", html)
	}
	return strings.TrimSuffix(strings.TrimPrefix(match, `data-symemo-node-id="`), `"`)
}

func readOptionalFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func equalByteMaps(left, right map[string][]byte) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if string(right[key]) != string(value) {
			return false
		}
	}
	return true
}

func assertRawJSONPath(t *testing.T, data []byte, path []string, want string) {
	t.Helper()
	var current any
	if err := json.Unmarshal(data, &current); err != nil {
		t.Fatal(err)
	}
	for _, segment := range path {
		switch node := current.(type) {
		case map[string]any:
			current = node[segment]
		case []any:
			if segment != "0" {
				t.Fatalf("unsupported test path segment %q for array", segment)
			}
			current = node[0]
		default:
			t.Fatalf("path %v reached %T", path, current)
		}
	}
	if current != want {
		t.Fatalf("path %v = %#v, want %#v in %s", path, current, want, data)
	}
}
