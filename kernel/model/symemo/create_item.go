// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package symemo

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/88250/lute/ast"
)

type createItemPlan struct {
	element     Element
	rootBytes   []byte
	sortBytes   []byte
	writeRoot   bool
	writeSort   bool
	contentRank int
}

func (engine *Engine) createItem(ctx context.Context, command CreateItemCommand) (CreateElementResult, error) {
	plan, err := engine.planCreateItem(command)
	if err != nil {
		return CreateElementResult{}, err
	}
	result := CreateElementResult{ElementID: command.ElementID}
	rootWritten := !plan.writeRoot
	sortWritten := !plan.writeSort
	if plan.writeRoot {
		if err = engine.config.writeRootElementSource(plan.element, plan.rootBytes); err != nil {
			if _, statErr := os.Stat(filepath.Join(engine.config.ElementsRoot(), command.ElementID+".sme")); !errors.Is(statErr, os.ErrNotExist) {
				rootWritten = true
			}
			return result, engine.classifyCreateItemWriteError(err, command.ElementID, rootWritten, sortWritten, plan.writeRoot, plan.writeSort)
		}
		rootWritten = true
	}
	if plan.writeSort {
		if err = engine.config.writeTopLevelSortRanks(plan.sortBytes); err != nil {
			if ranks, diagnostics := engine.config.loadSortRanks(); len(diagnostics) == 0 && ranks[command.ElementID] == plan.contentRank {
				sortWritten = true
			}
			return result, engine.classifyCreateItemWriteError(err, command.ElementID, rootWritten, sortWritten, plan.writeRoot, plan.writeSort)
		}
		sortWritten = true
	}
	result.CreateAccepted = rootWritten && sortWritten
	if err = engine.refreshProjectionWithConfig(ctx, engine.config.LoadEffectiveSchedulerConfig()); err != nil {
		engine.unavailable.Store(true)
		return result, createItemError(ErrProjectionRefreshFailed, "refresh created Item projection", command.ElementID, true, err)
	}
	result.Item, err = engine.createdItemSummary(command.ElementID)
	if err != nil {
		engine.unavailable.Store(true)
		return result, createItemError(ErrProjectionRefreshFailed, "read created Item projection", command.ElementID, true, err)
	}
	return result, nil
}

func (engine *Engine) planCreateItem(command CreateItemCommand) (createItemPlan, error) {
	if !ast.IsNodeIDPattern(command.ElementID) || strings.TrimSpace(command.Prompt) == "" || strings.TrimSpace(command.Answer) == "" {
		return createItemPlan{}, createItemError(ErrInvalidCreateCommand, "Item identity and Q/A content are required", command.ElementID, false, nil)
	}
	scan, err := engine.config.scanElements()
	if err != nil {
		return createItemPlan{}, createItemError(ErrHistoryRequiresRepair, "Element source requires repair", command.ElementID, false, err)
	}
	if len(scan.Diagnostics) != 0 {
		return createItemPlan{}, createItemError(ErrHistoryRequiresRepair, "Element source requires repair", command.ElementID, false, nil)
	}
	ranks, err := engine.config.loadSortRanksForCreate()
	if err != nil {
		return createItemPlan{}, err
	}
	rootPath := filepath.Join(engine.config.ElementsRoot(), command.ElementID+".sme")
	record, hasRecord := scan.Records[command.ElementID]
	if hasRecord {
		if record.StorageKind != StorageKindRootDocument || record.ParentID != "" || record.Element.Type != "item" || record.Element.Payload.Kind != "qa" || record.Element.Payload.Prompt != command.Prompt || record.Element.Payload.Answer != command.Answer {
			return createItemPlan{}, createItemError(ErrInvalidCreateCommand, "Item identity is owned by different authority", command.ElementID, false, nil)
		}
	} else if _, statErr := os.Stat(rootPath); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
		return createItemPlan{}, createItemError(ErrHistoryRequiresRepair, "Item source requires repair", command.ElementID, false, statErr)
	}

	rank, hasRank := ranks[command.ElementID]
	if !hasRank {
		rank, err = nextTopLevelSortRank(scan.Records)
		if err != nil {
			return createItemPlan{}, err
		}
		ranks[command.ElementID] = rank
	}
	element := record.Element
	if !hasRecord {
		element = Element{
			Spec: SupportedElementSpec, ID: command.ElementID, Type: "item", ProcessingState: "processed", PayloadSpec: SupportedPayloadSpec,
			Payload: ElementPayload{Kind: "qa", Prompt: command.Prompt, Answer: command.Answer, Revision: newElementAuthoringRevisionToken()},
		}
	}
	rootBytes, err := json.MarshalIndent(element, "", "  ")
	if err != nil {
		return createItemPlan{}, createItemError(ErrInvalidCreateCommand, "created Item source is not serializable", command.ElementID, false, err)
	}
	sortBytes, err := json.MarshalIndent(ranks, "", "  ")
	if err != nil {
		return createItemPlan{}, createItemError(ErrInvalidCreateCommand, "created Item sort metadata is not serializable", command.ElementID, false, err)
	}
	return createItemPlan{
		element: element, rootBytes: append(rootBytes, '\n'), sortBytes: append(sortBytes, '\n'),
		writeRoot: !hasRecord, writeSort: !hasRank, contentRank: rank,
	}, nil
}

func (engine *Engine) classifyCreateItemWriteError(err error, elementID string, rootWritten, sortWritten, rootRequired, sortRequired bool) error {
	if rootWritten && sortWritten {
		engine.unavailable.Store(true)
		return createItemError(ErrElementWritePartial, "created Item authority completed with an indeterminate response", elementID, false, err)
	}
	if (rootRequired && rootWritten) || (sortRequired && sortWritten) {
		engine.unavailable.Store(true)
		return createItemError(ErrElementWritePartial, "created Item authority is partial", elementID, false, err)
	}
	return createItemError(ErrDurableWriteFailed, "created Item authority could not be written", elementID, false, err)
}

func createItemError(code ErrorCode, message, elementID string, createAccepted bool, cause error) *DomainError {
	return &DomainError{
		Code: code, Message: message, Retryable: createAccepted, ElementID: elementID,
		CreateAccepted: createAccepted, Cause: cause,
	}
}

func (engine *Engine) createdItemSummary(elementID string) (*CreatedItemSummary, error) {
	element, err := engine.index.element(elementID)
	if err != nil {
		return nil, err
	}
	nodes, err := engine.index.tree()
	if err != nil {
		return nil, err
	}
	node, ok := projectedTreeNode(nodes, elementID)
	if !ok {
		return nil, errProjectionNotFound
	}
	return &CreatedItemSummary{
		ElementID: elementID, ProcessingState: element.ProcessingState, ContentRevision: element.Payload.Revision,
		SourcePath: node.SourcePath, SortRank: node.SortRank, LifecycleState: "pending",
	}, nil
}
