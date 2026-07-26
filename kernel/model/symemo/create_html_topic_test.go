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
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateHTMLTopicCreatesQueryableRootAndSchedule(t *testing.T) {
	engine, config := newFixtureEngine(t)
	elementID := "20260723090000-topicxx"
	eventID := "20260723090100-eventxx"
	restoreIDs := withCreateHTMLTopicNodeIDs(t, elementID, eventID)
	defer restoreIDs()

	result, err := engine.CreateElement(context.Background(), CreateElementCommand{
		Kind: CreateElementAddNewTopic,
		AddNewTopic: AddNewTopicCommand{
			Title: "  HTML Topic  ",
			HTML:  `<h2 data-symemo-node-id="caller">Heading</h2><script>bad()</script><p style="color: red; position: fixed">Body</p>`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ElementID != elementID || result.EventID != eventID || !result.CreateAccepted || !result.ReviewAccepted || result.Retryable || result.Topic == nil {
		t.Fatalf("create result = %#v", result)
	}
	if result.Topic.Title != "HTML Topic" || result.Topic.ProcessingState != "new" || result.Topic.ScheduleProfile != topicAFactorV1ID || result.Topic.AcceptedReviewAction != "NextTopic" || result.Topic.LifecycleState != "memorized" || result.Topic.InitialIntervalDays < 1 || result.Topic.InitialIntervalDays > 15 {
		t.Fatalf("created topic summary = %#v", result.Topic)
	}
	if result.Topic.PriorityPosition == nil || *result.Topic.PriorityPosition != 0 || result.Topic.CleaningPolicyVersion != topicHTMLCleaningPolicyVersion {
		t.Fatalf("created topic schedule/material summary = %#v", result.Topic)
	}

	elementResult, err := engine.Query(context.Background(), Query{Kind: QueryElement, ElementID: elementID})
	if err != nil {
		t.Fatal(err)
	}
	element := elementResult.Element
	if element == nil || element.Type != "topic" || element.Title != "HTML Topic" || element.ProcessingState != "new" || element.RootElementID != elementID || element.ParentElementID != "" || element.SourceMode != SourceModeHTML {
		t.Fatalf("created Element view = %#v", element)
	}
	material := element.Payload.Material
	if material == nil || material.Kind != "html" || material.CleaningPolicyVersion != topicHTMLCleaningPolicyVersion {
		t.Fatalf("created material = %#v", material)
	}
	if element.TitleRevision == "" || material.Revision == "" || element.TitleRevision == material.Revision {
		t.Fatalf("created revisions title=%q material=%q", element.TitleRevision, material.Revision)
	}
	normalizedHTML := feature004NodeIDPattern.ReplaceAllString(material.HTML, `data-symemo-node-id="ID"`)
	if normalizedHTML != `<h2 data-symemo-node-id="ID">Heading</h2><p data-symemo-node-id="ID" style="color: red">Body</p>` {
		t.Fatalf("cleaned HTML = %s", normalizedHTML)
	}
	if strings.Contains(material.HTML, "caller") || strings.Contains(material.HTML, "<script") || strings.Contains(material.HTML, "position:") {
		t.Fatalf("forbidden HTML survived: %s", material.HTML)
	}
	if element.ScheduleProjection == nil || element.ScheduleProjection.AdoptedTerminalID != eventID || element.ScheduleProjection.PriorityPosition != 0 || element.ScheduleProjection.AcceptedReviewAction != "NextTopic" {
		t.Fatalf("created projection = %#v", element.ScheduleProjection)
	}

	treeResult, err := engine.Query(context.Background(), Query{Kind: QueryElementTree, IncludeScheduleSummary: true})
	if err != nil {
		t.Fatal(err)
	}
	node, ok := projectedTreeNode(treeResult.Nodes, elementID)
	if !ok || node.ParentElementID != "" || len(node.Children) != 0 || node.ScheduleSummary == nil || node.ScheduleSummary.LifecycleState != "memorized" {
		t.Fatalf("created tree node = %#v", node)
	}
	if node.SortRank == nil || *node.SortRank != 0 {
		t.Fatalf("created sort rank = %#v", node.SortRank)
	}

	sourceBytes, err := os.ReadFile(filepath.Join(config.ElementsRoot(), elementID+".sme"))
	if err != nil {
		t.Fatal(err)
	}
	var source Element
	if err = json.Unmarshal(sourceBytes, &source); err != nil {
		t.Fatal(err)
	}
	if source.ID != elementID || len(source.Relations) != 0 || len(source.Children) != 0 || source.Payload.Material == nil || source.Payload.Material.HTML != material.HTML {
		t.Fatalf("created source = %#v", source)
	}
	if source.TitleRevision != element.TitleRevision || source.Payload.Material.Revision != material.Revision {
		t.Fatalf("created source revisions = %#v material=%#v", source, source.Payload.Material)
	}
	event := eventByID(t, mustEvents(t, config), eventID)
	if event.Type != "introduceElement" || event.ReviewKind != "introduceTopic" || event.BaseEventID != "" || event.ElementID != elementID || event.After.AdoptedTerminalID != eventID {
		t.Fatalf("created event = %#v", event)
	}
}

func TestCreateHTMLTopicAcceptsExplicitEmptyTitleAndHTML(t *testing.T) {
	engine, config := newFixtureEngine(t)
	elementID := "20260725065000-emptytp"
	eventID := "20260725065001-emptyev"
	restoreIDs := withCreateHTMLTopicNodeIDs(t, elementID, eventID)
	defer restoreIDs()

	result, err := engine.CreateElement(context.Background(), CreateElementCommand{
		Kind:        CreateElementAddNewTopic,
		AddNewTopic: AddNewTopicCommand{Title: " \t", HTML: "<p><br></p>"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.CreateAccepted || !result.ReviewAccepted || result.Topic == nil || result.Topic.Title != "" {
		t.Fatalf("empty create result = %#v", result)
	}
	detail := queryFeature006Element(t, engine, elementID)
	if detail.Title != "" || detail.TitleRevision == "" || detail.Payload.Material.HTML != "" || detail.Payload.Material.Revision == "" {
		t.Fatalf("empty detail = %#v", detail)
	}
	source := readOptionalFile(t, filepath.Join(config.ElementsRoot(), elementID+".sme"))
	if !strings.Contains(string(source), `"title": ""`) || !strings.Contains(string(source), `"html": ""`) || !strings.Contains(string(source), `"titleRevision":`) || !strings.Contains(string(source), `"revision":`) {
		t.Fatalf("empty source omits explicit fields: %s", source)
	}
	if countEventsByID(t, config, eventID) != 1 {
		t.Fatalf("empty create event count = %d", countEventsByID(t, config, eventID))
	}
}

func TestCreateHTMLTopicAcceptsWhitespaceEmptyTitleWithNonEmptyHTML(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	restoreIDs := withCreateHTMLTopicNodeIDs(t, "20260725065300-wshtml1", "20260725065301-wshtml2")
	defer restoreIDs()

	result, err := engine.CreateElement(context.Background(), CreateElementCommand{
		Kind: CreateElementAddNewTopic,
		AddNewTopic: AddNewTopicCommand{
			Title: "\u00a0 \t",
			HTML:  "<p>Body without title</p>",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	detail := queryFeature006Element(t, engine, result.ElementID)
	if detail.Title != "" || detail.Payload.Material.HTML == "" || result.Topic == nil || result.Topic.Title != "" {
		t.Fatalf("whitespace-title create detail=%#v result=%#v", detail, result)
	}
}

func TestCreateHTMLTopicRetriesGeneratedMaterialNodeIDOwnedByExistingTopic(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	existing := createFeature006Topic(t, engine, "20260725065400-owneraa", "20260725065401-owneree", "Owner", "<p>Owner</p>")
	existingDetail := queryFeature006Element(t, engine, existing.ElementID)
	existingNodeID := firstTopicNodeID(t, existingDetail.Payload.Material.HTML)
	restoreIDs := withCreateHTMLTopicNodeIDs(t, "20260725065402-newtopc", "20260725065403-newtope")
	defer restoreIDs()
	previousNodeID := newTopicHTMLNodeID
	generated := []string{existingNodeID, "20260725065404-newnode"}
	newTopicHTMLNodeID = func() string {
		id := generated[0]
		generated = generated[1:]
		return id
	}
	t.Cleanup(func() { newTopicHTMLNodeID = previousNodeID })

	result, err := engine.CreateElement(context.Background(), CreateElementCommand{
		Kind:        CreateElementAddNewTopic,
		AddNewTopic: AddNewTopicCommand{Title: "", HTML: "<p>New body</p>"},
	})
	if err != nil {
		t.Fatal(err)
	}
	detail := queryFeature006Element(t, engine, result.ElementID)
	if strings.Contains(detail.Payload.Material.HTML, existingNodeID) || !strings.Contains(detail.Payload.Material.HTML, "20260725065404-newnode") {
		t.Fatalf("created HTML used colliding node ID: %s", detail.Payload.Material.HTML)
	}
}

func TestCreateHTMLTopicOneHundredEmptyCreationCases(t *testing.T) {
	engine, config := newFixtureEngine(t)
	previousElementID, previousEventID := newCreateHTMLTopicElementID, newCreateHTMLTopicEventID
	elementSequence := 0
	eventSequence := 0
	newCreateHTMLTopicElementID = func() string {
		id := fmt.Sprintf("20260725065100-a%06d", elementSequence)
		elementSequence++
		return id
	}
	newCreateHTMLTopicEventID = func() string {
		id := fmt.Sprintf("20260725065100-b%06d", eventSequence)
		eventSequence++
		return id
	}
	t.Cleanup(func() {
		newCreateHTMLTopicElementID = previousElementID
		newCreateHTMLTopicEventID = previousEventID
	})

	for fixture := 0; fixture < 100; fixture++ {
		result, err := engine.CreateElement(t.Context(), CreateElementCommand{
			Kind:        CreateElementAddNewTopic,
			AddNewTopic: AddNewTopicCommand{Title: "", HTML: ""},
		})
		if err != nil {
			t.Fatalf("empty fixture %d create failed: %v", fixture, err)
		}
		detail := queryFeature006Element(t, engine, result.ElementID)
		if detail.Title != "" || detail.Payload.Material.HTML != "" || detail.TitleRevision == "" || detail.Payload.Material.Revision == "" || countEventsByID(t, config, result.EventID) != 1 {
			t.Fatalf("empty fixture %d detail=%#v result=%#v", fixture, detail, result)
		}
	}
}

func TestCreateHTMLTopicAcceptsLargeValidHTMLWithoutFeature006Limit(t *testing.T) {
	engine, _ := newFixtureEngine(t)
	restoreIDs := withCreateHTMLTopicNodeIDs(t, "20260725065200-largeok", "20260725065201-largeev")
	defer restoreIDs()
	var builder strings.Builder
	for i := 0; i < 2500; i++ {
		fmt.Fprintf(&builder, `<p>Large valid paragraph %04d with enough text to exceed any small Feature 006 transport threshold.</p>`, i)
	}
	result, err := engine.CreateElement(t.Context(), CreateElementCommand{
		Kind:        CreateElementAddNewTopic,
		AddNewTopic: AddNewTopicCommand{Title: "Large", HTML: builder.String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	detail := queryFeature006Element(t, engine, result.ElementID)
	if got := strings.Count(detail.Payload.Material.HTML, "<p "); got != 2500 {
		t.Fatalf("large HTML paragraph count = %d", got)
	}
}

func TestCreateHTMLTopicOneHundredCompleteFixtures(t *testing.T) {
	engine, config := newFixtureEngine(t)
	previousElementID, previousEventID := newCreateHTMLTopicElementID, newCreateHTMLTopicEventID
	elementSequence := 0
	eventSequence := 0
	newCreateHTMLTopicElementID = func() string {
		id := fmt.Sprintf("20260723160000-t%06d", elementSequence)
		elementSequence++
		return id
	}
	newCreateHTMLTopicEventID = func() string {
		id := fmt.Sprintf("20260723160000-e%06d", eventSequence)
		eventSequence++
		return id
	}
	t.Cleanup(func() {
		newCreateHTMLTopicElementID = previousElementID
		newCreateHTMLTopicEventID = previousEventID
	})

	created := make([]CreateElementResult, 0, 100)
	for fixture := 0; fixture < 100; fixture++ {
		title := fmt.Sprintf("Complete Topic %03d", fixture)
		result, err := engine.CreateElement(t.Context(), CreateElementCommand{
			Kind: CreateElementAddNewTopic,
			AddNewTopic: AddNewTopicCommand{
				Title: title,
				HTML:  fmt.Sprintf(`<section><h2>Heading %03d</h2><p style="color: #%06d">Body %03d</p></section>`, fixture, fixture, fixture),
			},
		})
		if err != nil {
			t.Fatalf("fixture %d create failed: %v", fixture, err)
		}
		if result.Topic == nil || !result.CreateAccepted || !result.ReviewAccepted || result.ElementID == "" || result.EventID == "" || result.Topic.Title != title {
			t.Fatalf("fixture %d result = %#v", fixture, result)
		}
		query, err := engine.Query(t.Context(), Query{Kind: QueryElement, ElementID: result.ElementID})
		if err != nil || query.Element == nil || query.Element.ScheduleProjection == nil || query.Element.ScheduleProjection.AdoptedTerminalID != result.EventID {
			t.Fatalf("fixture %d query = %#v, err=%v", fixture, query.Element, err)
		}
		created = append(created, result)
	}

	eventCounts := map[string]int{}
	for _, event := range mustEvents(t, config) {
		eventCounts[event.EventID]++
	}
	for fixture, result := range created {
		if eventCounts[result.EventID] != 1 {
			t.Fatalf("fixture %d event %q count = %d", fixture, result.EventID, eventCounts[result.EventID])
		}
	}
}
