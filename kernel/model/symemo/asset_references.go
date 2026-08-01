package symemo

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/siyuan-note/filelock"
	xhtml "golang.org/x/net/html"
)

func CollectAssetReferences(root string) ([]string, error) {
	return collectSMEAssetReferences(root)
}

func collectSMEAssetReferences(root string) ([]string, error) {
	paths := make([]string, 0)
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info == nil || info.IsDir() || strings.ToLower(filepath.Ext(path)) != ".sme" {
			return nil
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	sort.Strings(paths)
	references := map[string]bool{}
	for _, path := range paths {
		data, readErr := filelock.ReadFile(path)
		if readErr != nil {
			return nil, fmt.Errorf("read SiYuanMemo source %s: %w", path, readErr)
		}
		var value any
		if unmarshalErr := json.Unmarshal(data, &value); unmarshalErr != nil {
			return nil, fmt.Errorf("decode SiYuanMemo source %s: %w", path, unmarshalErr)
		}
		collectSMEAssetReferencesFromValue(value, "", references)
	}
	result := make([]string, 0, len(references))
	for reference := range references {
		result = append(result, reference)
	}
	sort.Strings(result)
	return result, nil
}

func collectSMEAssetReferencesFromValue(value any, key string, references map[string]bool) {
	switch typed := value.(type) {
	case map[string]any:
		for childKey, child := range typed {
			collectSMEAssetReferencesFromValue(child, childKey, references)
		}
	case []any:
		for _, child := range typed {
			collectSMEAssetReferencesFromValue(child, key, references)
		}
	case string:
		if key != "html" && key != "prompt" && key != "answer" {
			return
		}
		collectHTMLAssetReferences(typed, references)
	}
}

func collectHTMLAssetReferences(input string, references map[string]bool) {
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), xhtmlBodyContext())
	if err != nil {
		return
	}
	var walk func(*xhtml.Node)
	walk = func(node *xhtml.Node) {
		if node.Type == xhtml.ElementNode && strings.EqualFold(node.Data, "img") {
			for _, attr := range node.Attr {
				if strings.EqualFold(attr.Key, "src") {
					if reference := normalizeLocalAssetReference(attr.Val); reference != "" {
						references[reference] = true
					}
					break
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	for _, node := range nodes {
		walk(node)
	}
}
