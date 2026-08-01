package model

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/siyuan-note/siyuan/kernel/conf"
	"github.com/siyuan-note/siyuan/kernel/util"
)

func TestSiyuanMemoAssetReferencesAreAddedToNativeReferenceSet(t *testing.T) {
	previous := siyuanMemoAssetReferencePaths
	siyuanMemoAssetReferencePaths = func() ([]string, error) {
		return []string{"assets/item.png", "assets/topic.png"}, nil
	}
	t.Cleanup(func() { siyuanMemoAssetReferencePaths = previous })

	refs, err := collectSiyuanMemoAssetReferences()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(refs, []string{"assets/item.png", "assets/topic.png"}) {
		t.Fatalf("references = %#v", refs)
	}
}

func TestUnusedAssetsPreservesNativeAndSiyuanMemoReferences(t *testing.T) {
	originalConf, originalDataDir, originalTempDir, originalWorkspaceDir := Conf, util.DataDir, util.TempDir, util.WorkspaceDir
	t.Cleanup(func() {
		Conf, util.DataDir, util.TempDir, util.WorkspaceDir = originalConf, originalDataDir, originalTempDir, originalWorkspaceDir
	})

	root := t.TempDir()
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	util.WorkspaceDir = root
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()

	boxID := "20260801000000-abcdefg"
	box := &Box{ID: boxID}
	if err := box.SaveConf(conf.NewBoxConf()); err != nil {
		t.Fatal(err)
	}
	docID := "20260801000001-hijklmn"
	sy := fmt.Sprintf(`{"ID":"%s","Spec":"2","Type":"NodeDocument","Properties":{"id":"%s","title":"Native","type":"doc","updated":"20260801000001"},"Children":[{"Type":"NodeParagraph","ID":"20260801000002-opqrstu","Properties":{"id":"20260801000002-opqrstu","updated":"20260801000002"},"Children":[{"Type":"NodeImage","Data":"span","Children":[{"Type":"NodeBang"},{"Type":"NodeOpenBracket"},{"Type":"NodeLinkText","Data":"native"},{"Type":"NodeCloseBracket"},{"Type":"NodeOpenParen"},{"Type":"NodeLinkDest","Data":"assets/native.png"},{"Type":"NodeCloseParen"}]}]}]}`, docID, docID)
	if err := os.WriteFile(filepath.Join(util.DataDir, boxID, docID+".sy"), []byte(sy), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(util.DataDir, "assets"), 0755); err != nil {
		t.Fatal(err)
	}

	elementsRoot := filepath.Join(util.DataDir, "storage", "siyuanmemo", "elements")
	if err := os.MkdirAll(elementsRoot, 0755); err != nil {
		t.Fatal(err)
	}
	writeElement := func(name string, value any) {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(elementsRoot, name+".sme"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeElement("20260801000010-topic", map[string]any{
		"type":    "topic",
		"payload": map[string]any{"material": map[string]any{"html": `<p><img src="assets/topic.png"><img src="assets/shared.png"></p>`}},
	})
	writeElement("20260801000011-item", map[string]any{
		"type": "item",
		"payload": map[string]any{
			"prompt": `<p><img src="assets/prompt.png"><img src="assets/shared.png"></p>`,
			"answer": `<p><img src="assets/answer.png"><img src="assets/../unsafe.png"></p>`,
		},
	})
	for _, name := range []string{"native.png", "topic.png", "prompt.png", "answer.png", "shared.png", "orphan.png"} {
		if err := os.WriteFile(filepath.Join(util.DataDir, "assets", name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}

	items := UnusedAssets(false)
	got := make([]string, 0, len(items))
	for _, item := range items {
		got = append(got, item.Item)
	}
	if !reflect.DeepEqual(got, []string{"assets/orphan.png"}) {
		t.Fatalf("unused assets = %#v", got)
	}
}

func TestUnusedAssetsFreshScanProtectsReferenceAddedAfterPriorScan(t *testing.T) {
	originalConf, originalDataDir, originalTempDir, originalWorkspaceDir := Conf, util.DataDir, util.TempDir, util.WorkspaceDir
	t.Cleanup(func() {
		Conf, util.DataDir, util.TempDir, util.WorkspaceDir = originalConf, originalDataDir, originalTempDir, originalWorkspaceDir
	})

	root := t.TempDir()
	util.DataDir = filepath.Join(root, "data")
	util.TempDir = filepath.Join(root, "temp")
	util.WorkspaceDir = root
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	if err := os.MkdirAll(filepath.Join(util.DataDir, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(util.DataDir, "assets", "late.png"), []byte("late"), 0600); err != nil {
		t.Fatal(err)
	}

	first := UnusedAssets(false)
	if len(first) != 1 || first[0].Item != "assets/late.png" {
		t.Fatalf("first scan = %#v", first)
	}
	elementsRoot := filepath.Join(util.DataDir, "storage", "siyuanmemo", "elements")
	if err := os.MkdirAll(elementsRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(elementsRoot, "20260801000012-topic.sme"), []byte(`{"payload":{"material":{"html":"<p><img src=\"assets/late.png\"></p>"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	second := UnusedAssets(false)
	if len(second) != 0 {
		t.Fatalf("fresh scan still reports referenced asset: %#v", second)
	}
}
