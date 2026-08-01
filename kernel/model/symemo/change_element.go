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
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/siyuan-note/filelock"
	xhtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

var newElementAuthoringRevisionToken = randomElementAuthoringRevisionToken
var readChangeElementRootFile = filelock.ReadFile
var writeChangeElementRootFile = filelock.WriteFile
var marshalChangeElementRootJSON = json.MarshalIndent

type changeElementPlan struct {
	elementID        string
	field            ChangedElementField
	kind             ChangeElementKind
	expectedRevision string
	canonicalValue   string
	currentValue     string
	currentRevision  string
	prompt           string
	answer           string
	currentPrompt    string
	currentAnswer    string
	cleaningPolicy   string
	assignments      []MaterialNodeIdentityAssignment
	record           elementSourceRecord
	rootPath         string
	oldBytes         []byte
	newBytes         []byte
}

func (engine *Engine) changeElement(ctx context.Context, command ChangeElementCommand) (ChangeElementResult, error) {
	plan, err := engine.planChangeElement(command)
	if err != nil {
		return ChangeElementResult{}, err
	}
	result := ChangeElementResult{
		Kind:                    plan.kind,
		ElementID:               plan.elementID,
		ChangedField:            plan.field,
		CanonicalValue:          plan.canonicalValue,
		Revision:                plan.currentRevision,
		CleaningPolicyVersion:   plan.cleaningPolicy,
		NodeIdentityAssignments: plan.assignments,
		Changed:                 false,
		ChangeAccepted:          true,
	}
	if plan.field == ChangedElementItemQA {
		result.ItemQA = &CanonicalItemQA{
			Prompt: plan.prompt, Answer: plan.answer, ContentRevision: plan.currentRevision,
			CleaningPolicyVersion: plan.cleaningPolicy,
		}
	}
	if (plan.field == ChangedElementItemQA && plan.prompt == plan.currentPrompt && plan.answer == plan.currentAnswer) ||
		(plan.field != ChangedElementItemQA && plan.canonicalValue == plan.currentValue) {
		return result, nil
	}
	if plan.expectedRevision != plan.currentRevision {
		return ChangeElementResult{}, changeElementConflictError(plan.elementID, plan.field, plan.currentRevision)
	}
	result.Revision = newElementAuthoringRevisionToken()
	result.Changed = true
	if result.ItemQA != nil {
		result.ItemQA.ContentRevision = result.Revision
	}
	patch, err := patchChangeElementRoot(plan, result.Revision)
	if err != nil {
		return ChangeElementResult{}, err
	}
	plan.newBytes = patch
	result.CanonicalValue = plan.canonicalValue
	result.ChangeAccepted = false
	accepted, err := replaceChangeElementRoot(plan)
	if err != nil {
		return ChangeElementResult{}, err
	}
	if !accepted {
		return ChangeElementResult{}, changeElementDomainError(ErrDurableWriteFailed, "Element authority could not be written", plan.elementID, plan.field, true, false, err)
	}
	result.ChangeAccepted = true
	if err = engine.refreshProjectionWithConfig(ctx, engine.config.LoadEffectiveSchedulerConfig()); err != nil {
		acceptedChange := result
		return result, changeElementAcceptedError(ErrProjectionRefreshFailed, "refresh changed Element projection", plan.elementID, plan.field, &acceptedChange, err)
	}
	return result, nil
}

func (engine *Engine) planChangeElement(command ChangeElementCommand) (changeElementPlan, error) {
	shape, err := validateChangeElementCommand(command)
	if err != nil {
		return changeElementPlan{}, err
	}
	scan, err := engine.config.scanElements()
	if err != nil {
		return changeElementPlan{}, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", shape.elementID, shape.field, true, false, err)
	}
	record, ok := scan.Records[shape.elementID]
	if !ok {
		code := diagnosedElementSourceCode(shape.elementID, scan.Diagnostics)
		return changeElementPlan{}, changeElementDomainError(code, changeElementSourceMessage(code), shape.elementID, shape.field, code == ErrElementSourceUnavailable, false, nil)
	}
	if shape.field == ChangedElementItemQA {
		if record.Element.Type != "item" || record.Element.Payload.Kind != "qa" {
			return changeElementPlan{}, changeElementDomainError(ErrUnsupportedOperation, "Element is not writable Q/A Item content", shape.elementID, shape.field, false, false, nil)
		}
	} else if !isSupportedV1HTMLTopic(record.Element.Type, record.Element.Payload) {
		return changeElementPlan{}, changeElementDomainError(ErrUnsupportedOperation, "Element is not writable HTML Topic material", shape.elementID, shape.field, false, false, nil)
	}
	rootPath := filepath.Join(engine.config.ElementsRoot(), filepath.FromSlash(record.SourcePath))
	oldBytes, err := readChangeElementRootFile(rootPath)
	if err != nil {
		return changeElementPlan{}, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", shape.elementID, shape.field, true, false, err)
	}
	latestElement, err := changeElementAuthorityFromRootBytes(oldBytes, shape.elementID)
	if err != nil {
		return changeElementPlan{}, err
	}
	latestScan, err := engine.config.scanElements()
	if err != nil {
		return changeElementPlan{}, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", shape.elementID, shape.field, true, false, err)
	}
	if shape.field == ChangedElementMaterial && topicHTMLOwnershipDiagnosticsAmbiguous(latestScan.Diagnostics) {
		return changeElementPlan{}, changeElementDomainError(ErrInvalidTopicHTML, "Topic HTML ownership cannot be classified", shape.elementID, shape.field, false, false, nil)
	}
	verifiedBytes, err := readChangeElementRootFile(rootPath)
	if err != nil || string(verifiedBytes) != string(oldBytes) {
		return changeElementPlan{}, changeElementDomainError(ErrElementSourceUnavailable, "Element source changed during authoring validation", shape.elementID, shape.field, true, false, err)
	}
	latestRecord := record
	if scannedRecord, ok := latestScan.Records[shape.elementID]; ok && scannedRecord.SourcePath == record.SourcePath {
		latestRecord = scannedRecord
		latestRecord.Element = latestElement
	} else {
		return changeElementPlan{}, changeElementDomainError(ErrElementSourceUnavailable, "Element source changed during authoring validation", shape.elementID, shape.field, true, false, nil)
	}
	plan := changeElementPlan{
		elementID:        shape.elementID,
		field:            shape.field,
		kind:             command.Kind,
		expectedRevision: shape.expectedRevision,
		record:           latestRecord,
		rootPath:         rootPath,
		oldBytes:         oldBytes,
	}
	switch shape.field {
	case ChangedElementTitle:
		current := latestElement.Title
		plan.currentValue = current
		plan.currentRevision = latestElement.TitleRevision
		plan.canonicalValue = shape.value
	case ChangedElementMaterial:
		if !isSupportedV1HTMLTopic(latestElement.Type, latestElement.Payload) {
			return changeElementPlan{}, changeElementDomainError(ErrUnsupportedOperation, "Element is not writable HTML Topic material", shape.elementID, shape.field, false, false, nil)
		}
		current := latestElement.Payload.Material
		ownedNodeIDs := collectTopicHTMLNodeIDs(current.HTML)
		globalNodeOwners := collectTopicHTMLNodeOwners(latestScan)
		if topicHTMLNodeOwnersAmbiguous(globalNodeOwners) {
			return changeElementPlan{}, changeElementDomainError(ErrInvalidTopicHTML, "Topic HTML ownership cannot be classified", shape.elementID, shape.field, false, false, nil)
		}
		cleaned, cleanErr := cleanTopicHTMLFragmentForEdit(shape.value, shape.elementID, ownedNodeIDs, globalNodeOwners)
		if cleanErr != nil {
			return changeElementPlan{}, changeElementDomainError(ErrInvalidTopicHTML, "Topic HTML is invalid", shape.elementID, shape.field, false, false, cleanErr)
		}
		plan.currentValue = current.HTML
		plan.currentRevision = current.Revision
		plan.canonicalValue = cleaned.HTML
		plan.cleaningPolicy = topicHTMLCleaningPolicyVersion
		plan.assignments = cleaned.Assignments
	case ChangedElementItemQA:
		if latestElement.Type != "item" || latestElement.Payload.Kind != "qa" {
			return changeElementPlan{}, changeElementDomainError(ErrUnsupportedOperation, "Element is not writable Q/A Item content", shape.elementID, shape.field, false, false, nil)
		}
		prompt, promptErr := canonicalizeItemHTML(shape.prompt)
		if promptErr != nil {
			return changeElementPlan{}, changeElementDomainError(ErrInvalidChangeCommand, "Item prompt HTML is invalid", shape.elementID, shape.field, false, false, promptErr)
		}
		answer, answerErr := canonicalizeItemHTML(shape.answer)
		if answerErr != nil {
			return changeElementPlan{}, changeElementDomainError(ErrInvalidChangeCommand, "Item answer HTML is invalid", shape.elementID, shape.field, false, false, answerErr)
		}
		plan.currentPrompt = latestElement.Payload.Prompt
		plan.currentAnswer = latestElement.Payload.Answer
		plan.currentRevision = latestElement.Payload.Revision
		plan.prompt = prompt
		plan.answer = answer
		plan.cleaningPolicy = itemHTMLCleaningPolicyVersion
	}
	return plan, nil
}

func changeElementAuthorityFromRootBytes(data []byte, elementID string) (Element, error) {
	var root Element
	if err := json.Unmarshal(data, &root); err != nil {
		return Element{}, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", elementID, "", true, false, err)
	}
	var matches []Element
	var walk func(Element)
	walk = func(element Element) {
		if element.ID == elementID {
			recordElement := element
			recordElement.Children = nil
			if material := recordElement.Payload.Material; material != nil && material.Kind == "html" && material.CleaningPolicyVersion == topicHTMLCleaningPolicyVersion {
				hardenedMaterial := *material
				hardenedHTML, hardenErr := hardenStoredTopicHTML(hardenedMaterial.HTML)
				if hardenErr != nil {
					matches = append(matches, recordElement)
					return
				}
				hardenedMaterial.HTML = hardenedHTML
				recordElement.Payload.Material = &hardenedMaterial
			}
			applyEffectiveElementAuthoringRevisions(&recordElement)
			matches = append(matches, recordElement)
		}
		for _, child := range element.Children {
			walk(child)
		}
	}
	walk(root)
	if len(matches) != 1 {
		code := ErrElementNotFound
		if len(matches) > 1 {
			code = ErrElementSourceAmbiguous
		}
		return Element{}, changeElementDomainError(code, changeElementSourceMessage(code), elementID, "", code == ErrElementSourceUnavailable, false, nil)
	}
	return matches[0], nil
}

type changeElementCommandShape struct {
	elementID        string
	field            ChangedElementField
	expectedRevision string
	value            string
	prompt           string
	answer           string
}

func validateChangeElementCommand(command ChangeElementCommand) (changeElementCommandShape, error) {
	hasRename := command.RenameElement != (RenameElementCommand{})
	hasSave := command.SaveTopicHTML != (SaveTopicHTMLCommand{})
	hasItemQA := command.SaveItemQA != (SaveItemQACommand{})
	switch command.Kind {
	case ChangeElementRenameElement:
		if !hasRename || hasItemQA {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command shape is invalid", command.RenameElement.ElementID, ChangedElementTitle, false, false, nil)
		}
		if hasSave {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command shape is invalid", command.RenameElement.ElementID, ChangedElementTitle, false, false, nil)
		}
		title, err := canonicalizeElementTitle(command.RenameElement.Title)
		if err != nil {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidElementTitle, "Element title is invalid", command.RenameElement.ElementID, ChangedElementTitle, false, false, err)
		}
		if command.RenameElement.ElementID == "" || command.RenameElement.ExpectedTitleRevision == "" {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command shape is invalid", command.RenameElement.ElementID, ChangedElementTitle, false, false, nil)
		}
		return changeElementCommandShape{elementID: command.RenameElement.ElementID, field: ChangedElementTitle, expectedRevision: command.RenameElement.ExpectedTitleRevision, value: title}, nil
	case ChangeElementSaveTopicHTML:
		if !hasSave || hasItemQA {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command shape is invalid", command.SaveTopicHTML.ElementID, ChangedElementMaterial, false, false, nil)
		}
		if hasRename || command.SaveTopicHTML.ElementID == "" || command.SaveTopicHTML.ExpectedMaterialRevision == "" {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command shape is invalid", command.SaveTopicHTML.ElementID, ChangedElementMaterial, false, false, nil)
		}
		return changeElementCommandShape{elementID: command.SaveTopicHTML.ElementID, field: ChangedElementMaterial, expectedRevision: command.SaveTopicHTML.ExpectedMaterialRevision, value: command.SaveTopicHTML.HTML}, nil
	case ChangeElementSaveItemQA:
		item := command.SaveItemQA
		if !hasItemQA || hasRename || hasSave || item.ElementID == "" || item.ExpectedContentRevision == "" || strings.TrimSpace(item.Prompt) == "" || strings.TrimSpace(item.Answer) == "" {
			return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command shape is invalid", item.ElementID, ChangedElementItemQA, false, false, nil)
		}
		return changeElementCommandShape{elementID: item.ElementID, field: ChangedElementItemQA, expectedRevision: item.ExpectedContentRevision, prompt: item.Prompt, answer: item.Answer}, nil
	default:
		return changeElementCommandShape{}, changeElementDomainError(ErrInvalidChangeCommand, "ChangeElement command kind is invalid", "", "", false, false, nil)
	}
}

func canonicalizeElementTitle(title string) (string, error) {
	canonical := strings.TrimSpace(title)
	if utf8.RuneCountInString(canonical) > 512 {
		return "", errors.New("Element title is too long")
	}
	for _, r := range canonical {
		if r == '\n' || r == '\r' || r == '\t' || (unicode.IsControl(r) && r != '\u200c' && r != '\u200d') {
			return "", errors.New("Element title contains a prohibited control character")
		}
	}
	return canonical, nil
}

func patchChangeElementRoot(plan changeElementPlan, revision string) ([]byte, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(plan.oldBytes, &root); err != nil {
		return nil, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", plan.elementID, plan.field, true, false, err)
	}
	matches, err := patchChangeElementObject(root, plan, revision)
	if err != nil {
		return nil, err
	}
	if matches != 1 {
		return nil, changeElementDomainError(ErrElementSourceAmbiguous, "Element source is ambiguous", plan.elementID, plan.field, false, false, nil)
	}
	data, err := marshalChangeElementRootJSON(root, "", "  ")
	if err != nil {
		return nil, changeElementDomainError(ErrInvalidChangeCommand, "Element source is not serializable", plan.elementID, plan.field, false, false, err)
	}
	return append(data, '\n'), nil
}

func patchChangeElementObject(object map[string]json.RawMessage, plan changeElementPlan, revision string) (int, error) {
	matches := 0
	var id string
	_ = json.Unmarshal(object["id"], &id)
	if id == plan.elementID {
		matches++
		switch plan.field {
		case ChangedElementTitle:
			titleData, _ := json.Marshal(plan.canonicalValue)
			revisionData, _ := json.Marshal(revision)
			object["title"] = titleData
			object["titleRevision"] = revisionData
		case ChangedElementMaterial:
			payloadData, err := patchChangeElementMaterialPayload(object["payload"], plan.canonicalValue, revision)
			if err != nil {
				return 0, err
			}
			object["payload"] = payloadData
		case ChangedElementItemQA:
			payloadData, err := patchChangeElementItemQAPayload(object["payload"], plan.prompt, plan.answer, revision)
			if err != nil {
				return 0, err
			}
			object["payload"] = payloadData
		}
	}
	childrenRaw, ok := object["children"]
	if !ok {
		return matches, nil
	}
	var children []json.RawMessage
	if err := json.Unmarshal(childrenRaw, &children); err != nil {
		return 0, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", plan.elementID, plan.field, true, false, err)
	}
	for index, childRaw := range children {
		var child map[string]json.RawMessage
		if err := json.Unmarshal(childRaw, &child); err != nil {
			return 0, changeElementDomainError(ErrElementSourceUnavailable, "Element source is unavailable", plan.elementID, plan.field, true, false, err)
		}
		childMatches, err := patchChangeElementObject(child, plan, revision)
		if err != nil {
			return 0, err
		}
		if childMatches == 0 {
			continue
		}
		matches += childMatches
		updated, err := json.Marshal(child)
		if err != nil {
			return 0, err
		}
		children[index] = updated
	}
	if matches > 0 {
		updatedChildren, err := json.Marshal(children)
		if err != nil {
			return 0, err
		}
		object["children"] = updatedChildren
	}
	return matches, nil
}

func patchChangeElementMaterialPayload(payloadRaw json.RawMessage, html, revision string) (json.RawMessage, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		return nil, err
	}
	var material map[string]json.RawMessage
	if err := json.Unmarshal(payload["material"], &material); err != nil {
		return nil, err
	}
	htmlData, _ := json.Marshal(html)
	revisionData, _ := json.Marshal(revision)
	policyData, _ := json.Marshal(topicHTMLCleaningPolicyVersion)
	kindData, _ := json.Marshal("html")
	material["kind"] = kindData
	material["html"] = htmlData
	material["cleaningPolicyVersion"] = policyData
	material["revision"] = revisionData
	materialData, err := json.Marshal(material)
	if err != nil {
		return nil, err
	}
	payload["material"] = materialData
	return json.Marshal(payload)
}

func patchChangeElementItemQAPayload(payloadRaw json.RawMessage, prompt, answer, revision string) (json.RawMessage, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		return nil, err
	}
	promptData, _ := json.Marshal(prompt)
	answerData, _ := json.Marshal(answer)
	revisionData, _ := json.Marshal(revision)
	kindData, _ := json.Marshal("qa")
	payload["kind"] = kindData
	payload["prompt"] = promptData
	payload["answer"] = answerData
	payload["revision"] = revisionData
	return json.Marshal(payload)
}

func replaceChangeElementRoot(plan changeElementPlan) (bool, error) {
	currentBeforeWrite, err := readChangeElementRootFile(plan.rootPath)
	if err != nil || string(currentBeforeWrite) != string(plan.oldBytes) {
		return false, changeElementDomainError(ErrElementSourceUnavailable, "Element source changed before replacement", plan.elementID, plan.field, true, false, err)
	}
	if err := writeChangeElementRootFile(plan.rootPath, plan.newBytes); err == nil {
		return true, nil
	} else {
		current, readErr := readChangeElementRootFile(plan.rootPath)
		if readErr != nil {
			return false, changeElementDomainError(ErrElementWritePartial, "Element authority replacement is indeterminate", plan.elementID, plan.field, false, false, err)
		}
		if string(current) == string(plan.newBytes) {
			return true, nil
		}
		if string(current) == string(plan.oldBytes) {
			return false, nil
		}
		return false, changeElementDomainError(ErrElementWritePartial, "Element authority replacement is indeterminate", plan.elementID, plan.field, false, false, err)
	}
}

func applyEffectiveElementAuthoringRevisions(element *Element) {
	if element.Type == "item" && element.Payload.Kind == "qa" {
		if element.Payload.Revision == "" {
			element.Payload.Revision = legacyElementAuthoringRevision(element.ID, "item-qa", element.Payload.Prompt+"\x00"+element.Payload.Answer)
		}
		return
	}
	if !isSupportedV1HTMLTopic(element.Type, element.Payload) {
		return
	}
	if element.TitleRevision == "" {
		element.TitleRevision = legacyElementAuthoringRevision(element.ID, "title", element.Title)
	}
	if element.Payload.Material.Revision == "" {
		material := *element.Payload.Material
		material.Revision = legacyElementAuthoringRevision(element.ID, "material", material.HTML)
		element.Payload.Material = &material
	}
}

func legacyElementAuthoringRevision(elementID, field, value string) string {
	hash := sha256.Sum256([]byte(elementID + "\x00" + field + "\x00" + value))
	return "legacy-v1-" + base64.RawURLEncoding.EncodeToString(hash[:])
}

func randomElementAuthoringRevisionToken() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("generate Element revision: %v", err))
	}
	return "rev-v1-" + base64.RawURLEncoding.EncodeToString(buffer)
}

func collectTopicHTMLNodeOwners(scan elementScanResult) map[string]string {
	owners := map[string]string{}
	for _, element := range scan.Elements {
		if !isSupportedV1HTMLTopic(element.Type, element.Payload) {
			continue
		}
		for id := range collectTopicHTMLNodeIDs(element.Payload.Material.HTML) {
			if owners[id] == "" {
				owners[id] = element.ID
			} else if owners[id] != element.ID {
				owners[id] = "\x00ambiguous"
			}
		}
	}
	return owners
}

func topicHTMLNodeOwnersAmbiguous(owners map[string]string) bool {
	for _, owner := range owners {
		if owner == "\x00ambiguous" {
			return true
		}
	}
	return false
}

func topicHTMLOwnershipDiagnosticsAmbiguous(diagnostics []ElementSourceDiagnostic) bool {
	for _, diagnostic := range diagnostics {
		switch diagnostic.Code {
		case sourceUnreadableCode, sourceMalformedCode, sourceIdentityCode, sourcePayloadCode, sourceIncompleteCode, sourceDuplicateCode, materialEncrypted:
			return true
		}
	}
	return false
}

func collectTopicHTMLNodeIDs(input string) map[string]bool {
	ids := map[string]bool{}
	if input == "" {
		return ids
	}
	context := xhtmlBodyContext()
	nodes, err := parseTopicHTMLFragment(input, context)
	if err != nil {
		return ids
	}
	var walk func(*xhtml.Node)
	walk = func(node *xhtml.Node) {
		if node.Type == xhtml.ElementNode {
			if id := topicHTMLAttrValue(node, "data-symemo-node-id"); id != "" {
				ids[id] = true
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	for _, node := range nodes {
		walk(node)
	}
	return ids
}

func parseTopicHTMLFragment(input string, context *xhtml.Node) ([]*xhtml.Node, error) {
	return xhtml.ParseFragment(strings.NewReader(input), context)
}

func xhtmlBodyContext() *xhtml.Node {
	return &xhtml.Node{Type: xhtml.ElementNode, DataAtom: atom.Body, Data: "body"}
}

func changeElementConflictError(elementID string, field ChangedElementField, currentRevision string) error {
	err := changeElementDomainError(ErrElementRevisionConflict, "Element revision conflict", elementID, field, false, false, nil)
	err.CurrentRevision = currentRevision
	return err
}

func changeElementAcceptedError(code ErrorCode, message, elementID string, field ChangedElementField, accepted *ChangeElementResult, cause error) *DomainError {
	err := changeElementDomainError(code, message, elementID, field, true, true, cause)
	err.AcceptedChange = accepted
	return err
}

func changeElementDomainError(code ErrorCode, message, elementID string, field ChangedElementField, retryable, accepted bool, cause error) *DomainError {
	return &DomainError{
		Code:           code,
		Message:        message,
		Retryable:      retryable,
		ElementID:      elementID,
		ChangedField:   field,
		ChangeAccepted: accepted,
		Cause:          cause,
	}
}

func changedFieldForCommand(command ChangeElementCommand) ChangedElementField {
	switch command.Kind {
	case ChangeElementRenameElement:
		return ChangedElementTitle
	case ChangeElementSaveTopicHTML:
		return ChangedElementMaterial
	default:
		return ""
	}
}

func changeElementSourceMessage(code ErrorCode) string {
	switch code {
	case ErrElementSourceAmbiguous:
		return "Element source is ambiguous"
	case ErrElementSourceUnavailable:
		return "Element source is unavailable"
	case ErrElementNotFound:
		return "Element was not found"
	default:
		return "Element source is unavailable"
	}
}
