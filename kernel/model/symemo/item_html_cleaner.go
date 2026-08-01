package symemo

import (
	"errors"
	"html"
	"strings"

	xhtml "golang.org/x/net/html"
)

const itemHTMLCleaningPolicyVersion = topicHTMLCleaningPolicyVersion

func cleanItemHTML(input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", errors.New("Item HTML is empty")
	}
	options := topicHTMLCleanOptions{identityMode: topicHTMLIdentityGenerate}
	context := xhtmlBodyContext()
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), context)
	if err != nil {
		return "", err
	}
	root := &xhtml.Node{Type: xhtml.DocumentNode}
	for _, node := range cleanTopicHTMLChildren(nodes, &options) {
		appendHTMLChild(root, node)
	}
	if options.err != nil {
		return "", options.err
	}
	var builder strings.Builder
	renderable := false
	for node := root.FirstChild; node != nil; node = node.NextSibling {
		if topicHTMLNodeRenderable(node) {
			renderable = true
		}
		renderTopicHTMLNode(&builder, node)
	}
	if !renderable || strings.TrimSpace(builder.String()) == "" {
		return "", errors.New("Item HTML has no renderable material")
	}
	return builder.String(), nil
}

func migrateItemPlainTextHTML(input string) (string, error) {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(input, "\r\n", "\n"), "\r", "\n"), "\n")
	var builder strings.Builder
	for _, line := range lines {
		if line == "" {
			builder.WriteString("<p><br></p>")
			continue
		}
		builder.WriteString("<p>")
		builder.WriteString(html.EscapeString(line))
		builder.WriteString("</p>")
	}
	if builder.Len() == 0 {
		return "", errors.New("Item text is empty")
	}
	return builder.String(), nil
}

func canonicalizeItemHTML(input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", errors.New("Item HTML is empty")
	}
	if !looksLikeItemHTML(input) {
		migrated, err := migrateItemPlainTextHTML(input)
		if err != nil {
			return "", err
		}
		return cleanItemHTML(migrated)
	}
	return cleanItemHTML(input)
}

func looksLikeItemHTML(input string) bool {
	trimmed := strings.TrimSpace(input)
	if !strings.HasPrefix(trimmed, "<") {
		return false
	}
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), xhtmlBodyContext())
	if err != nil {
		return false
	}
	var hasSupportedElement func(*xhtml.Node) bool
	hasSupportedElement = func(node *xhtml.Node) bool {
		if node.Type == xhtml.ElementNode && topicHTMLKeepsElement(strings.ToLower(node.Data), node) {
			return true
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if hasSupportedElement(child) {
				return true
			}
		}
		return false
	}
	for _, node := range nodes {
		if hasSupportedElement(node) {
			return true
		}
	}
	return false
}
