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

package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/88250/gulu"
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/model"
	"github.com/siyuan-note/siyuan/kernel/model/symemo"
	"github.com/siyuan-note/siyuan/kernel/util"
)

var symemoIsBooted = util.IsBooted
var symemoBootProgress = func() int { return int(util.GetBootProgress()) }
var symemoBootMessage = func(progress int) string {
	return fmt.Sprintf(model.Conf.Language(74), progress)
}
var symemoQuery = model.QuerySymemo
var symemoRunLearningAction = model.RunSymemoLearningAction
var symemoCreateElement = model.CreateSymemoElement
var symemoChangeElement = model.ChangeSymemoElement

var symemoLogError = func(code string, cause error) {
	logging.LogErrorf("SiYuanMemo request failed [code=%s]: %s", code, cause)
}

const (
	symemoInvalidRequestCode                       = "invalid-request"
	symemoInternalErrorCode                        = "internal-error"
	symemoLearningElementUnavailableLanguageNumber = 10000
)

var symemoSafeMessages = map[string]string{
	symemoInvalidRequestCode:                          "Invalid request.",
	symemoInternalErrorCode:                           "SiYuanMemo could not complete the request.",
	string(symemo.ErrUnsupportedOperation):            "This operation is not supported.",
	string(symemo.ErrInvalidSessionPhase):             "This learning action is not available in the current phase.",
	string(symemo.ErrTargetMismatch):                  "The requested Element is not the current learning target.",
	string(symemo.ErrUnsupportedGrade):                "The grade is not supported.",
	string(symemo.ErrAuthoritativeElementUnavailable): "The learning Element is unavailable.",
	string(symemo.ErrUnsupportedAlgorithmState):       "The scheduling state is not supported.",
	string(symemo.ErrInvalidAlgorithmOutput):          "The scheduling result is invalid.",
	string(symemo.ErrDurableWriteFailed):              "The review could not be saved.",
	string(symemo.ErrProjectionRefreshFailed):         "The review was saved, but its schedule could not be refreshed.",
	string(symemo.ErrQueueAdvanceFailed):              "The review was saved, but the learning queue could not advance.",
	string(symemo.ErrHistoryRequiresRepair):           "The review history requires repair.",
	string(symemo.ErrInvalidCreateCommand):            "The Element could not be created.",
	string(symemo.ErrInvalidChangeCommand):            "The Element change request is invalid.",
	string(symemo.ErrInvalidElementTitle):             "The Topic title is invalid.",
	string(symemo.ErrInvalidTopicHTML):                "The Topic HTML is invalid.",
	string(symemo.ErrElementWritePartial):             "The Element could not be created.",
	string(symemo.ErrElementNotFound):                 "The Element was not found.",
	string(symemo.ErrElementSourceUnavailable):        "The Element source is unavailable.",
	string(symemo.ErrElementSourceAmbiguous):          "The Element source is ambiguous.",
	string(symemo.ErrElementRevisionConflict):         "The Topic changed elsewhere.",
	string(symemo.ErrProjectionRebuildFailed):         "The Element index could not be rebuilt.",
}

func symemoSafeMessage(code string) string {
	if code == string(symemo.ErrAuthoritativeElementUnavailable) && model.Conf != nil {
		return model.Conf.Language(symemoLearningElementUnavailableLanguageNumber)
	}
	return symemoSafeMessages[code]
}

func registerSymemoRoutes(ginServer *gin.Engine) {
	ginServer.Handle("POST", "/api/symemo/getElementSubset", model.CheckAuth, model.CheckAdminRole, getSymemoElementSubset)
	ginServer.Handle("POST", "/api/symemo/getElementTree", model.CheckAuth, model.CheckAdminRole, getSymemoElementTree)
	ginServer.Handle("POST", "/api/symemo/getElement", model.CheckAuth, model.CheckAdminRole, getSymemoElement)
	ginServer.Handle("POST", "/api/symemo/getItemAuthoring", model.CheckAuth, model.CheckAdminRole, getSymemoItemAuthoring)
	ginServer.Handle("POST", "/api/symemo/getElementSourceDiagnostics", model.CheckAuth, model.CheckAdminRole, getSymemoElementSourceDiagnostics)
	ginServer.Handle("POST", "/api/symemo/createHTMLTopic", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, createHTMLTopic)
	ginServer.Handle("POST", "/api/symemo/createItem", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, createSymemoItem)
	ginServer.Handle("POST", "/api/symemo/renameElement", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, renameSymemoElement)
	ginServer.Handle("POST", "/api/symemo/saveTopicHTML", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, saveSymemoTopicHTML)
	ginServer.Handle("POST", "/api/symemo/saveItemQA", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, saveSymemoItemQA)
	ginServer.Handle("POST", "/api/symemo/startLearning", model.CheckAuth, model.CheckAdminRole, startSymemoLearning)
	ginServer.Handle("POST", "/api/symemo/showAnswer", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, showSymemoAnswer)
	ginServer.Handle("POST", "/api/symemo/gradeItem", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, gradeSymemoItem)
	ginServer.Handle("POST", "/api/symemo/nextTopic", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, nextSymemoTopic)
	ginServer.Handle("POST", "/api/symemo/acceptLearningStage", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, acceptSymemoLearningStage)
	ginServer.Handle("POST", "/api/symemo/declineLearningStage", model.CheckAuth, model.CheckAdminRole, declineSymemoLearningStage)
	ginServer.Handle("POST", "/api/symemo/gradeDrill", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, gradeSymemoDrill)
	ginServer.Handle("POST", "/api/symemo/stopLearning", model.CheckAuth, model.CheckAdminRole, stopSymemoLearning)
	ginServer.Handle("POST", "/api/symemo/getCurrentLearningSession", model.CheckAuth, model.CheckAdminRole, getSymemoCurrentSession)
}

type symemoSubsetRequest struct {
	Subset string `json:"subset" binding:"required"`
}

type symemoElementRequest struct {
	ElementID string `json:"elementId" binding:"required"`
}

type symemoElementTreeRequest struct {
	RootElementID          string `json:"rootElementId"`
	IncludeScheduleSummary bool   `json:"includeScheduleSummary"`
}

type symemoElementDiagnosticsRequest struct {
	ElementID  string `json:"elementId"`
	SourcePath string `json:"sourcePath"`
}

type symemoCreateHTMLTopicRequest struct {
	Title string `json:"title"`
	HTML  string `json:"html"`
}

type symemoCreateItemRequest struct {
	ElementID string `json:"elementId"`
	Prompt    string `json:"prompt"`
	Answer    string `json:"answer"`
}

type symemoGetItemAuthoringRequest struct {
	ElementID string `json:"elementId"`
}

type symemoSaveItemQARequest struct {
	ElementID               string `json:"elementId"`
	ExpectedContentRevision string `json:"expectedContentRevision"`
	Prompt                  string `json:"prompt"`
	Answer                  string `json:"answer"`
}

type symemoRenameElementRequest struct {
	ElementID             string `json:"elementId"`
	ExpectedTitleRevision string `json:"expectedTitleRevision"`
	Title                 string `json:"title"`
}

type symemoSaveTopicHTMLRequest struct {
	ElementID                string `json:"elementId"`
	ExpectedMaterialRevision string `json:"expectedMaterialRevision"`
	HTML                     string `json:"html"`
}

type symemoGradeRequest struct {
	ElementID string `json:"elementId" binding:"required"`
	RawGrade  *int   `json:"rawGrade" binding:"required"`
	EventID   string `json:"eventId" binding:"required"`
}

type symemoNextTopicRequest struct {
	ElementID string `json:"elementId" binding:"required"`
	EventID   string `json:"eventId" binding:"required"`
}

type symemoStageRequest struct {
	Stage symemo.LearningStage `json:"stage" binding:"required"`
}

func getSymemoElementSubset(c *gin.Context) {
	var request symemoSubsetRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoQuery(c, symemo.Query{Kind: symemo.QueryElementSubset, Subset: request.Subset})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func getSymemoElementTree(c *gin.Context) {
	var request symemoElementTreeRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoQuery(c, symemo.Query{Kind: symemo.QueryElementTree, RootElementID: request.RootElementID, IncludeScheduleSummary: request.IncludeScheduleSummary})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func ensureSymemoBooted(c *gin.Context) bool {
	if symemoIsBooted() {
		return true
	}
	writeSymemoFailure(c, symemoBootMessage(symemoBootProgress()), map[string]any{"closeTimeout": 5000})
	return false
}

func getSymemoElement(c *gin.Context) {
	var request symemoElementRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoQuery(c, symemo.Query{Kind: symemo.QueryElement, ElementID: request.ElementID})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, redactSymemoElementAnswer(result.Element))
}

func getSymemoItemAuthoring(c *gin.Context) {
	var request symemoGetItemAuthoringRequest
	if !bindGetItemAuthoringRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoQuery(c, symemo.Query{Kind: symemo.QueryItemAuthoring, ElementID: request.ElementID})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.ItemAuthoring)
}

func getSymemoElementSourceDiagnostics(c *gin.Context) {
	var request symemoElementDiagnosticsRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoQuery(c, symemo.Query{Kind: symemo.QueryElementSourceDiagnostics, ElementID: request.ElementID, SourcePath: request.SourcePath})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, struct {
		Diagnostics []symemo.ElementSourceDiagnostic `json:"diagnostics"`
	}{Diagnostics: result.Diagnostics})
}
func createHTMLTopic(c *gin.Context) {
	var request symemoCreateHTMLTopicRequest
	if !bindCreateHTMLTopicRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoCreateElement(c, symemo.CreateElementCommand{Kind: symemo.CreateElementAddNewTopic, AddNewTopic: symemo.AddNewTopicCommand{Title: request.Title, HTML: request.HTML}})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func createSymemoItem(c *gin.Context) {
	var request symemoCreateItemRequest
	if !bindCreateItemRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoCreateElement(c, symemo.CreateElementCommand{Kind: symemo.CreateElementCreateItem, CreateItem: symemo.CreateItemCommand{ElementID: request.ElementID, Prompt: request.Prompt, Answer: request.Answer}})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func renameSymemoElement(c *gin.Context) {
	var request symemoRenameElementRequest
	if !bindRenameElementRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoChangeElement(c, symemo.ChangeElementCommand{
		Kind: symemo.ChangeElementRenameElement,
		RenameElement: symemo.RenameElementCommand{
			ElementID:             request.ElementID,
			ExpectedTitleRevision: request.ExpectedTitleRevision,
			Title:                 request.Title,
		},
	})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func saveSymemoTopicHTML(c *gin.Context) {
	var request symemoSaveTopicHTMLRequest
	if !bindSaveTopicHTMLRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoChangeElement(c, symemo.ChangeElementCommand{
		Kind: symemo.ChangeElementSaveTopicHTML,
		SaveTopicHTML: symemo.SaveTopicHTMLCommand{
			ElementID:                request.ElementID,
			ExpectedMaterialRevision: request.ExpectedMaterialRevision,
			HTML:                     request.HTML,
		},
	})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func saveSymemoItemQA(c *gin.Context) {
	var request symemoSaveItemQARequest
	if !bindSaveItemQARequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoChangeElement(c, symemo.ChangeElementCommand{Kind: symemo.ChangeElementSaveItemQA, SaveItemQA: symemo.SaveItemQACommand{ElementID: request.ElementID, ExpectedContentRevision: request.ExpectedContentRevision, Prompt: request.Prompt, Answer: request.Answer}})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func redactSymemoElementAnswer(element *symemo.ElementReadView) *symemo.ElementReadView {
	if element == nil || element.Type != "item" {
		return element
	}
	redacted := *element
	redacted.Payload.Answer = ""
	return &redacted
}

func startSymemoLearning(c *gin.Context) {
	if !bindSymemoEmptyRequest(c) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionStart})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.Session)
}

func showSymemoAnswer(c *gin.Context) {
	var request symemoElementRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionShowAnswer, ElementID: request.ElementID})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.Session)
}

func gradeSymemoItem(c *gin.Context) {
	var request symemoGradeRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionGradeItem, ElementID: request.ElementID, RawGrade: request.RawGrade, EventID: request.EventID})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func nextSymemoTopic(c *gin.Context) {
	var request symemoNextTopicRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionNextTopic, ElementID: request.ElementID, EventID: request.EventID})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func acceptSymemoLearningStage(c *gin.Context) {
	var request symemoStageRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionAcceptStageTransition, Stage: request.Stage})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.Session)
}

func declineSymemoLearningStage(c *gin.Context) {
	var request symemoStageRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionDeclineStageTransition, Stage: request.Stage})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.Session)
}

func gradeSymemoDrill(c *gin.Context) {
	var request symemoGradeRequest
	if !bindSymemoRequest(c, &request) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionGradeDrill, ElementID: request.ElementID, RawGrade: request.RawGrade, EventID: request.EventID})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result)
}

func stopSymemoLearning(c *gin.Context) {
	if !bindSymemoEmptyRequest(c) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoRunLearningAction(c, symemo.LearningAction{Kind: symemo.ActionStop})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.Session)
}

func getSymemoCurrentSession(c *gin.Context) {
	if !bindSymemoEmptyRequest(c) {
		return
	}
	if !ensureSymemoBooted(c) {
		return
	}
	result, err := symemoQuery(c, symemo.Query{Kind: symemo.QueryCurrentSession})
	if err != nil {
		writeSymemoError(c, err)
		return
	}
	writeSymemoSuccess(c, result.Session)
}

func bindSymemoRequest(c *gin.Context, request any) bool {
	if err := c.ShouldBindJSON(request); err != nil {
		writeSymemoFailure(c, symemoSafeMessage(symemoInvalidRequestCode), map[string]any{"errorCode": symemoInvalidRequestCode, "retryable": false, "changeAccepted": false})
		return false
	}
	return true
}
func bindCreateHTMLTopicRequest(c *gin.Context, request *symemoCreateHTMLTopicRequest) bool {
	return bindSymemoStringFields(c, map[string]*string{
		"title": &request.Title,
		"html":  &request.HTML,
	})
}

func bindCreateItemRequest(c *gin.Context, request *symemoCreateItemRequest) bool {
	if !bindSymemoStringFields(c, map[string]*string{
		"elementId": &request.ElementID,
		"prompt":    &request.Prompt,
		"answer":    &request.Answer,
	}) {
		return false
	}
	if request.ElementID == "" || strings.TrimSpace(request.Prompt) == "" || strings.TrimSpace(request.Answer) == "" {
		writeSymemoInvalidRequest(c)
		return false
	}
	return true
}

func bindGetItemAuthoringRequest(c *gin.Context, request *symemoGetItemAuthoringRequest) bool {
	if !bindSymemoStringFields(c, map[string]*string{"elementId": &request.ElementID}) {
		return false
	}
	if request.ElementID == "" {
		writeSymemoInvalidRequest(c)
		return false
	}
	return true
}

func bindSaveItemQARequest(c *gin.Context, request *symemoSaveItemQARequest) bool {
	if !bindSymemoStringFields(c, map[string]*string{
		"elementId":               &request.ElementID,
		"expectedContentRevision": &request.ExpectedContentRevision,
		"prompt":                  &request.Prompt,
		"answer":                  &request.Answer,
	}) {
		return false
	}
	if request.ElementID == "" || request.ExpectedContentRevision == "" || strings.TrimSpace(request.Prompt) == "" || strings.TrimSpace(request.Answer) == "" {
		writeSymemoInvalidRequest(c)
		return false
	}
	return true
}

func bindRenameElementRequest(c *gin.Context, request *symemoRenameElementRequest) bool {
	return bindSymemoStringFields(c, map[string]*string{
		"elementId":             &request.ElementID,
		"expectedTitleRevision": &request.ExpectedTitleRevision,
		"title":                 &request.Title,
	})
}

func bindSaveTopicHTMLRequest(c *gin.Context, request *symemoSaveTopicHTMLRequest) bool {
	return bindSymemoStringFields(c, map[string]*string{
		"elementId":                &request.ElementID,
		"expectedMaterialRevision": &request.ExpectedMaterialRevision,
		"html":                     &request.HTML,
	})
}

func bindSymemoStringFields(c *gin.Context, fields map[string]*string) bool {
	decoder := json.NewDecoder(c.Request.Body)
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		writeSymemoInvalidRequest(c)
		return false
	}
	values := make(map[string]string, len(fields))
	for decoder.More() {
		keyToken, keyErr := decoder.Token()
		key, keyIsString := keyToken.(string)
		if keyErr != nil || !keyIsString {
			writeSymemoInvalidRequest(c)
			return false
		}
		if _, known := fields[key]; !known {
			writeSymemoInvalidRequest(c)
			return false
		}
		if _, duplicate := values[key]; duplicate {
			writeSymemoInvalidRequest(c)
			return false
		}
		var rawValue json.RawMessage
		if decodeErr := decoder.Decode(&rawValue); decodeErr != nil || !symemoRawJSONIsString(rawValue) {
			writeSymemoInvalidRequest(c)
			return false
		}
		var value string
		if json.Unmarshal(rawValue, &value) != nil {
			writeSymemoInvalidRequest(c)
			return false
		}
		values[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || len(values) != len(fields) {
		writeSymemoInvalidRequest(c)
		return false
	}
	var trailing struct{}
	if err = decoder.Decode(&trailing); err != io.EOF {
		writeSymemoInvalidRequest(c)
		return false
	}
	for key, target := range fields {
		*target = values[key]
	}
	return true
}

func writeSymemoInvalidRequest(c *gin.Context) {
	writeSymemoFailure(c, symemoSafeMessage(symemoInvalidRequestCode), map[string]any{"errorCode": symemoInvalidRequestCode, "retryable": false, "changeAccepted": false})
}

func symemoRawJSONIsString(value json.RawMessage) bool {
	for _, b := range value {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		default:
			return b == '"'
		}
	}
	return false
}

func bindSymemoEmptyRequest(c *gin.Context) bool {
	if c.Request.ContentLength == 0 {
		return true
	}
	var request map[string]any
	return bindSymemoRequest(c, &request)
}

func writeSymemoSuccess(c *gin.Context, data any) {
	result := gulu.Ret.NewResult()
	result.Data = data
	c.JSON(http.StatusOK, result)
}

func writeSymemoError(c *gin.Context, err error) {
	if domainErr, ok := symemo.AsDomainError(err); ok {
		code := string(domainErr.Code)
		message := symemoSafeMessageForDomainError(domainErr)
		_, known := symemoSafeMessages[code]
		if !known {
			symemoLogError(symemoInternalErrorCode, err)
			writeSymemoFailure(c, symemoSafeMessage(symemoInternalErrorCode), map[string]any{"errorCode": symemoInternalErrorCode, "retryable": false, "changeAccepted": false})
			return
		}
		if domainErr.Cause != nil {
			symemoLogError(code, domainErr.Cause)
		}
		writeSymemoFailure(c, message, symemoFailureData(domainErr))
		return
	}
	symemoLogError(symemoInternalErrorCode, err)
	writeSymemoFailure(c, symemoSafeMessage(symemoInternalErrorCode), map[string]any{"errorCode": symemoInternalErrorCode, "retryable": false, "changeAccepted": false})
}

func symemoSafeMessageForDomainError(domainErr *symemo.DomainError) string {
	if domainErr.Code == symemo.ErrProjectionRefreshFailed && domainErr.AcceptedChange != nil {
		return "The change was saved, but the Element index could not be refreshed."
	}
	if domainErr.ChangedField != "" {
		switch domainErr.Code {
		case symemo.ErrDurableWriteFailed, symemo.ErrElementWritePartial:
			return "The change could not be saved."
		}
	}
	return symemoSafeMessage(string(domainErr.Code))
}

func symemoFailureData(domainErr *symemo.DomainError) map[string]any {
	data := map[string]any{
		"errorCode":      domainErr.Code,
		"retryable":      domainErr.Retryable,
		"changeAccepted": domainErr.ChangeAccepted,
	}
	if domainErr.ElementID != "" {
		data["elementId"] = domainErr.ElementID
	}
	if domainErr.EventID != "" {
		data["eventId"] = domainErr.EventID
	}
	if domainErr.AcceptedEventID != "" {
		data["acceptedEventId"] = domainErr.AcceptedEventID
	}
	if domainErr.EventID != "" || domainErr.AcceptedEventID != "" || domainErr.CreateAccepted || domainErr.ReviewAccepted {
		data["createAccepted"] = domainErr.CreateAccepted
		data["reviewAccepted"] = domainErr.ReviewAccepted
	}
	if domainErr.Session != nil {
		data["session"] = domainErr.Session
	}
	if domainErr.ChangedField != "" {
		data["changedField"] = domainErr.ChangedField
	}
	if domainErr.CurrentRevision != "" {
		data["currentRevision"] = domainErr.CurrentRevision
	}
	if domainErr.AcceptedChange != nil {
		if domainErr.AcceptedChange.ChangedField == symemo.ChangedElementItemQA {
			data["acceptedChange"] = domainErr.AcceptedChange
		} else {
			data["change"] = domainErr.AcceptedChange
		}
	}
	return data
}

func writeSymemoFailure(c *gin.Context, message string, data map[string]any) {
	result := gulu.Ret.NewResult()
	result.Code = -1
	result.Msg = message
	result.Data = data
	c.JSON(http.StatusOK, result)
}
