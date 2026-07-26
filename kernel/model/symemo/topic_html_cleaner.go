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
	"crypto/sha256"
	"errors"
	"html"
	"math/big"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/88250/lute/ast"
	xhtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const topicHTMLCleaningPolicyVersion = "siyuanmemo-topic-html-v1"

var newTopicHTMLNodeID = ast.NewNodeID

var safeCSSScalarPattern = regexp.MustCompile(`^[#a-zA-Z0-9\s.,()%+-]+$`)
var topicHTMLClientNodeKeyPattern = regexp.MustCompile(`^client-v1-[0-9]{14}-[A-Za-z0-9_-]{22,}$`)

type topicHTMLIdentityMode int

const (
	topicHTMLIdentityGenerate topicHTMLIdentityMode = iota
	topicHTMLIdentityEdit
)

type topicHTMLCleanOptions struct {
	allowEmpty         bool
	identityMode       topicHTMLIdentityMode
	elementID          string
	ownedNodeIDs       map[string]bool
	globalNodeOwners   map[string]string
	usedNodeIDs        map[string]bool
	usedClientNodeKeys map[string]bool
	assignments        []MaterialNodeIdentityAssignment
	err                error
}

type topicHTMLCleanResult struct {
	HTML        string
	Assignments []MaterialNodeIdentityAssignment
}

func cleanTopicHTMLFragment(input string) (string, error) {
	result, err := cleanTopicHTMLFragmentWithOptions(input, topicHTMLCleanOptions{identityMode: topicHTMLIdentityGenerate})
	if err != nil {
		return "", err
	}
	return result.HTML, nil
}

func cleanTopicHTMLFragmentForCreation(input string) (topicHTMLCleanResult, error) {
	return cleanTopicHTMLFragmentWithOptions(input, topicHTMLCleanOptions{allowEmpty: true, identityMode: topicHTMLIdentityGenerate})
}

func cleanTopicHTMLFragmentForEdit(input, elementID string, ownedNodeIDs map[string]bool, globalNodeOwners map[string]string) (topicHTMLCleanResult, error) {
	return cleanTopicHTMLFragmentWithOptions(input, topicHTMLCleanOptions{
		allowEmpty:       true,
		identityMode:     topicHTMLIdentityEdit,
		elementID:        elementID,
		ownedNodeIDs:     ownedNodeIDs,
		globalNodeOwners: globalNodeOwners,
	})
}

func cleanTopicHTMLFragmentWithOptions(input string, options topicHTMLCleanOptions) (topicHTMLCleanResult, error) {
	if strings.TrimSpace(input) == "" {
		if options.allowEmpty {
			return topicHTMLCleanResult{}, nil
		}
		return topicHTMLCleanResult{}, errors.New("HTML is empty")
	}
	options.usedNodeIDs = map[string]bool{}
	options.usedClientNodeKeys = map[string]bool{}
	context := &xhtml.Node{Type: xhtml.ElementNode, DataAtom: atom.Body, Data: "body"}
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), context)
	if err != nil {
		return topicHTMLCleanResult{}, err
	}
	root := &xhtml.Node{Type: xhtml.DocumentNode}
	for _, node := range cleanTopicHTMLChildren(nodes, &options) {
		appendHTMLChild(root, node)
	}
	if options.err != nil {
		return topicHTMLCleanResult{}, options.err
	}
	if err = assignTopicHTMLNodeIDs(root, &options); err != nil {
		return topicHTMLCleanResult{}, err
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
		if options.allowEmpty && topicHTMLEmptyIntent(input) {
			return topicHTMLCleanResult{Assignments: options.assignments}, nil
		}
		return topicHTMLCleanResult{}, errors.New("HTML has no renderable Topic material")
	}
	return topicHTMLCleanResult{HTML: builder.String(), Assignments: options.assignments}, nil
}

func cleanTopicHTMLChildren(nodes []*xhtml.Node, options *topicHTMLCleanOptions) []*xhtml.Node {
	var out []*xhtml.Node
	for _, node := range nodes {
		out = append(out, cleanTopicHTMLNode(node, options)...)
	}
	return out
}

func cleanTopicHTMLNode(node *xhtml.Node, options *topicHTMLCleanOptions) []*xhtml.Node {
	switch node.Type {
	case xhtml.TextNode:
		return []*xhtml.Node{{Type: xhtml.TextNode, Data: node.Data}}
	case xhtml.ElementNode:
		name := strings.ToLower(node.Data)
		if topicHTMLDropsSubtree(name) {
			return nil
		}
		children := cleanTopicHTMLChildren(htmlNodeChildren(node), options)
		if !topicHTMLKeepsElement(name, node) {
			return children
		}
		cleaned := &xhtml.Node{Type: xhtml.ElementNode, Data: name, Attr: sanitizeTopicHTMLAttrs(name, node.Attr, options)}
		if topicHTMLMathElement(name, node) && topicHTMLAttrValue(cleaned, "data-content") == "" {
			return nil
		}
		if name == "img" && topicHTMLAttrValue(cleaned, "src") == "" {
			return nil
		}
		if topicHTMLMathElement(name, node) {
			return []*xhtml.Node{cleaned}
		}
		for _, child := range children {
			appendHTMLChild(cleaned, child)
		}
		return []*xhtml.Node{cleaned}
	default:
		return nil
	}
}

func htmlNodeChildren(node *xhtml.Node) []*xhtml.Node {
	var children []*xhtml.Node
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		children = append(children, child)
	}
	return children
}

func appendHTMLChild(parent, child *xhtml.Node) {
	child.Parent = parent
	child.PrevSibling = parent.LastChild
	child.NextSibling = nil
	if parent.LastChild != nil {
		parent.LastChild.NextSibling = child
	} else {
		parent.FirstChild = child
	}
	parent.LastChild = child
}

func topicHTMLDropsSubtree(name string) bool {
	switch name {
	case "head", "title", "script", "style", "link", "meta", "base", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option", "video", "audio", "source", "track", "canvas", "svg", "math":
		return true
	default:
		return false
	}
}

func topicHTMLKeepsElement(name string, node *xhtml.Node) bool {
	if name == "html" || name == "body" {
		return false
	}
	if name == "span" || name == "div" {
		return topicHTMLMathElement(name, node)
	}
	switch name {
	case "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "hr", "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "a", "img":
		return true
	default:
		return false
	}
}

func hasTopicHTMLAttr(node *xhtml.Node, key, value string) bool {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, key) && attr.Val == value {
			return true
		}
	}
	return false
}

func sanitizeTopicHTMLAttrs(name string, attrs []xhtml.Attribute, options *topicHTMLCleanOptions) []xhtml.Attribute {
	values := map[string]string{}
	stableNodeID := ""
	clientNodeKey := ""
	for _, attr := range attrs {
		key := strings.ToLower(attr.Key)
		if strings.HasPrefix(key, "on") {
			continue
		}
		switch key {
		case "data-symemo-node-id":
			stableNodeID = strings.TrimSpace(attr.Val)
		case "data-symemo-client-node-key":
			clientNodeKey = strings.TrimSpace(attr.Val)
		case "style":
			if style := sanitizeTopicHTMLStyle(attr.Val); style != "" {
				values[key] = style
			}
		case "href":
			if name == "a" {
				if href := sanitizeTopicHTMLURL(attr.Val, true); href != "" {
					values[key] = href
				}
			}
		case "src":
			if name == "img" {
				if src := sanitizeTopicHTMLURL(attr.Val, false); src != "" {
					values[key] = src
				}
			}
		case "alt", "title":
			if name == "img" || name == "a" {
				values[key] = attr.Val
			}
		case "id":
			if isSafeTopicHTMLID(attr.Val) {
				values[key] = attr.Val
			}
		case "colspan", "rowspan":
			if (name == "td" || name == "th") && isPositiveSmallInteger(attr.Val) {
				values[key] = strings.TrimSpace(attr.Val)
			}
		case "scope":
			if name == "th" && isSafeTopicHTMLToken(attr.Val) {
				values[key] = strings.TrimSpace(attr.Val)
			}
		case "start":
			if name == "ol" && isPositiveSmallInteger(attr.Val) {
				values[key] = strings.TrimSpace(attr.Val)
			}
		case "reversed":
			if name == "ol" {
				values[key] = "reversed"
			}
		case "data-type":
			if (name == "span" && attr.Val == "inline-math") || (name == "div" && attr.Val == "NodeMathBlock") {
				values[key] = attr.Val
			}
		case "data-subtype":
			if (name == "span" || name == "div") && attr.Val == "math" {
				values[key] = attr.Val
			}
		case "data-content":
			if (name == "span" || name == "div") && attr.Val != "" && topicHTMLMathContentSafe(attr.Val) {
				values[key] = attr.Val
			}
		}
	}
	if values["data-content"] != "" && values["data-subtype"] == "math" {
		values["data-symemo-katex-trust"] = "false"
	}
	applyTopicHTMLIdentityAttrs(name, stableNodeID, clientNodeKey, values, options)
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]xhtml.Attribute, 0, len(keys))
	for _, key := range keys {
		out = append(out, xhtml.Attribute{Key: key, Val: values[key]})
	}
	return out
}

func applyTopicHTMLIdentityAttrs(name, stableNodeID, clientNodeKey string, values map[string]string, options *topicHTMLCleanOptions) {
	if stableNodeID == "" && clientNodeKey == "" {
		return
	}
	if options.identityMode != topicHTMLIdentityEdit {
		return
	}
	if !topicHTMLNeedsNodeID(name) {
		options.err = errors.New("Topic material identity is attached to an unsupported node")
		return
	}
	if stableNodeID != "" && clientNodeKey != "" {
		options.err = errors.New("Topic material node has both stable and client identities")
		return
	}
	if stableNodeID != "" {
		owner, ownedGlobally := options.globalNodeOwners[stableNodeID]
		if !ast.IsNodeIDPattern(stableNodeID) || !options.ownedNodeIDs[stableNodeID] || options.usedNodeIDs[stableNodeID] || (ownedGlobally && owner != options.elementID) {
			options.err = errors.New("Topic material node identity is invalid")
			return
		}
		options.usedNodeIDs[stableNodeID] = true
		values["data-symemo-node-id"] = stableNodeID
		return
	}
	if !topicHTMLClientNodeKeyPattern.MatchString(clientNodeKey) || options.usedClientNodeKeys[clientNodeKey] {
		options.err = errors.New("Topic material client identity is invalid")
		return
	}
	nodeID := deriveTopicHTMLClientNodeID(options.elementID, clientNodeKey)
	owner, ownedGlobally := options.globalNodeOwners[nodeID]
	if ownedGlobally && owner != options.elementID {
		options.err = errors.New("Topic material client identity collides with another Topic")
		return
	}
	if options.usedNodeIDs[nodeID] {
		options.err = errors.New("Topic material client identity collides in submitted material")
		return
	}
	options.usedClientNodeKeys[clientNodeKey] = true
	options.usedNodeIDs[nodeID] = true
	values["data-symemo-node-id"] = nodeID
	options.assignments = append(options.assignments, MaterialNodeIdentityAssignment{ClientNodeKey: clientNodeKey, NodeID: nodeID})
}

func topicHTMLMathElement(name string, node *xhtml.Node) bool {
	if name == "span" {
		return hasTopicHTMLAttr(node, "data-type", "inline-math") && hasTopicHTMLAttr(node, "data-subtype", "math")
	}
	return name == "div" && hasTopicHTMLAttr(node, "data-type", "NodeMathBlock") && hasTopicHTMLAttr(node, "data-subtype", "math")
}

func topicHTMLRenderedMathElement(node *xhtml.Node) bool {
	return node.Type == xhtml.ElementNode && hasTopicHTMLAttr(node, "data-subtype", "math")
}

func topicHTMLMathContentSafe(content string) bool {
	withoutComments := stripTopicHTMLMathComments(content)
	for i := 0; i < len(withoutComments); {
		if withoutComments[i] != '\\' {
			i++
			continue
		}
		i++
		start := i
		for i < len(withoutComments) && isTopicHTMLMathCommandByte(withoutComments[i]) {
			i++
		}
		if start == i {
			if i < len(withoutComments) {
				i++
			}
			continue
		}
		command := withoutComments[start:i]
		if strings.HasPrefix(command, "html") || unsafeTopicHTMLMathCommands[command] {
			return false
		}
	}
	compact := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, withoutComments)
	for _, scheme := range []string{"javascript:", "vbscript:", "data:", "file:"} {
		if strings.Contains(compact, scheme) {
			return false
		}
	}
	return true
}

func hardenStoredTopicHTML(input string) (string, error) {
	context := &xhtml.Node{Type: xhtml.ElementNode, DataAtom: atom.Body, Data: "body"}
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), context)
	if err != nil {
		return "", err
	}
	changed := false
	var harden func(*xhtml.Node) bool
	harden = func(node *xhtml.Node) bool {
		for child := node.FirstChild; child != nil; {
			next := child.NextSibling
			if !harden(child) {
				node.RemoveChild(child)
				changed = true
			}
			child = next
		}
		if !topicHTMLRenderedMathElement(node) {
			return true
		}
		content := topicHTMLAttrValue(node, "data-content")
		if content == "" || !topicHTMLMathContentSafe(content) {
			return false
		}
		markerCount := 0
		markerIsFalse := false
		attrs := node.Attr[:0]
		for _, attr := range node.Attr {
			if attr.Key == "data-symemo-katex-trust" {
				markerCount++
				markerIsFalse = attr.Val == "false"
				continue
			}
			attrs = append(attrs, attr)
		}
		if markerCount != 1 || !markerIsFalse {
			changed = true
		}
		node.Attr = append(attrs, xhtml.Attribute{Key: "data-symemo-katex-trust", Val: "false"})
		sort.Slice(node.Attr, func(i, j int) bool { return node.Attr[i].Key < node.Attr[j].Key })
		return true
	}
	kept := nodes[:0]
	for _, node := range nodes {
		if harden(node) {
			kept = append(kept, node)
		} else {
			changed = true
		}
	}
	if !changed {
		return input, nil
	}
	var builder strings.Builder
	for _, node := range kept {
		renderTopicHTMLNode(&builder, node)
	}
	return builder.String(), nil
}

var unsafeTopicHTMLMathCommands = map[string]bool{
	"catcode":         true,
	"csname":          true,
	"def":             true,
	"edef":            true,
	"endcsname":       true,
	"expandafter":     true,
	"futurelet":       true,
	"gdef":            true,
	"global":          true,
	"href":            true,
	"includegraphics": true,
	"let":             true,
	"long":            true,
	"newcommand":      true,
	"noexpand":        true,
	"providecommand":  true,
	"renewcommand":    true,
	"url":             true,
	"xdef":            true,
}

func stripTopicHTMLMathComments(content string) string {
	var builder strings.Builder
	for i := 0; i < len(content); i++ {
		if content[i] != '%' || topicHTMLMathPercentEscaped(content, i) {
			builder.WriteByte(content[i])
			continue
		}
		for i+1 < len(content) && content[i+1] != '\n' && content[i+1] != '\r' {
			i++
		}
		if i+1 < len(content) && content[i+1] == '\r' {
			i++
		}
		if i+1 < len(content) && content[i+1] == '\n' {
			i++
		}
	}
	return builder.String()
}

func topicHTMLMathPercentEscaped(content string, percent int) bool {
	backslashes := 0
	for i := percent - 1; i >= 0 && content[i] == '\\'; i-- {
		backslashes++
	}
	return backslashes%2 == 1
}

func isTopicHTMLMathCommandByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value == '@'
}

func sanitizeTopicHTMLURL(raw string, allowFragment bool) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "#") {
		if allowFragment && len(trimmed) > 1 && !strings.ContainsAny(trimmed, " \t\r\n") {
			return trimmed
		}
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return trimmed
}

func sanitizeTopicHTMLStyle(raw string) string {
	allowed := map[string]bool{
		"font-weight":      true,
		"font-style":       true,
		"text-decoration":  true,
		"text-align":       true,
		"color":            true,
		"background-color": true,
	}
	order := []string{"background-color", "color", "font-style", "font-weight", "text-align", "text-decoration"}
	values := map[string]string{}
	for _, declaration := range strings.Split(raw, ";") {
		parts := strings.SplitN(declaration, ":", 2)
		if len(parts) != 2 {
			continue
		}
		property := strings.ToLower(strings.TrimSpace(parts[0]))
		value := strings.Join(strings.Fields(strings.TrimSpace(parts[1])), " ")
		lowerValue := strings.ToLower(value)
		if !allowed[property] || value == "" || !safeCSSScalarPattern.MatchString(value) || strings.Contains(lowerValue, "url(") || strings.Contains(lowerValue, "var(") || strings.Contains(lowerValue, "calc(") || strings.Contains(lowerValue, "expression") || strings.ContainsAny(value, `@<>{}\`) {
			continue
		}
		values[property] = value
	}
	var kept []string
	for _, property := range order {
		if value, ok := values[property]; ok {
			kept = append(kept, property+": "+value)
		}
	}
	return strings.Join(kept, "; ")
}

func isSafeTopicHTMLID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, " \t\r\n<>\"'`") {
		return false
	}
	return true
}

func isSafeTopicHTMLToken(value string) bool {
	return isSafeTopicHTMLID(value)
}

func isPositiveSmallInteger(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 4 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != "0"
}

func assignTopicHTMLNodeIDs(root *xhtml.Node, options *topicHTMLCleanOptions) error {
	var assignmentErr error
	var walk func(*xhtml.Node)
	walk = func(node *xhtml.Node) {
		if assignmentErr != nil {
			return
		}
		if node.Type == xhtml.ElementNode && topicHTMLNeedsNodeID(node.Data) && topicHTMLAttrValue(node, "data-symemo-node-id") == "" {
			id := ""
			for attempt := 0; attempt < 32; attempt++ {
				candidate := newTopicHTMLNodeID()
				if !ast.IsNodeIDPattern(candidate) || options.usedNodeIDs[candidate] || options.globalNodeOwners[candidate] != "" {
					continue
				}
				id = candidate
				break
			}
			if id == "" {
				assignmentErr = errors.New("generated Topic material node identity is unavailable")
				return
			}
			options.usedNodeIDs[id] = true
			node.Attr = append(node.Attr, xhtml.Attribute{Key: "data-symemo-node-id", Val: id})
			sort.Slice(node.Attr, func(i, j int) bool { return node.Attr[i].Key < node.Attr[j].Key })
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return assignmentErr
}

func topicHTMLEmptyIntent(input string) bool {
	context := &xhtml.Node{Type: xhtml.ElementNode, DataAtom: atom.Body, Data: "body"}
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), context)
	if err != nil {
		return false
	}
	for _, node := range nodes {
		if !topicHTMLNodeEmptyIntent(node) {
			return false
		}
	}
	return true
}

func topicHTMLNodeEmptyIntent(node *xhtml.Node) bool {
	switch node.Type {
	case xhtml.TextNode:
		return topicHTMLEmptyText(node.Data)
	case xhtml.CommentNode:
		return true
	case xhtml.ElementNode:
		name := strings.ToLower(node.Data)
		switch name {
		case "html", "body", "p", "div", "br":
		default:
			return false
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if !topicHTMLNodeEmptyIntent(child) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func topicHTMLEmptyText(value string) bool {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\u200b' || r == '\ufeff'
	}) == ""
}

func deriveTopicHTMLClientNodeID(elementID, clientNodeKey string) string {
	hash := sha256.Sum256([]byte(elementID + "\x00material-node\x00" + clientNodeKey))
	value := new(big.Int).SetBytes(hash[:])
	space := new(big.Int).Exp(big.NewInt(36), big.NewInt(7), nil)
	value.Mod(value, space)
	suffix := strings.ToLower(value.Text(36))
	if len(suffix) < 7 {
		suffix = strings.Repeat("0", 7-len(suffix)) + suffix
	}
	return clientNodeKey[len("client-v1-"):len("client-v1-")+14] + "-" + suffix
}

func topicHTMLNeedsNodeID(name string) bool {
	switch name {
	case "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre", "td", "th", "figure", "hr":
		return true
	case "div":
		return true
	default:
		return false
	}
}

func topicHTMLNodeRenderable(node *xhtml.Node) bool {
	switch node.Type {
	case xhtml.TextNode:
		return strings.TrimSpace(node.Data) != ""
	case xhtml.ElementNode:
		if node.Data == "img" && topicHTMLAttrValue(node, "src") != "" {
			return true
		}
		if node.Data == "hr" {
			return true
		}
		if (node.Data == "span" || node.Data == "div") && topicHTMLAttrValue(node, "data-content") != "" {
			return true
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if topicHTMLNodeRenderable(child) {
				return true
			}
		}
	}
	return false
}

func topicHTMLAttrValue(node *xhtml.Node, key string) string {
	for _, attr := range node.Attr {
		if attr.Key == key {
			return attr.Val
		}
	}
	return ""
}

func renderTopicHTMLNode(builder *strings.Builder, node *xhtml.Node) {
	switch node.Type {
	case xhtml.TextNode:
		builder.WriteString(html.EscapeString(node.Data))
	case xhtml.ElementNode:
		builder.WriteByte('<')
		builder.WriteString(node.Data)
		for _, attr := range node.Attr {
			builder.WriteByte(' ')
			builder.WriteString(attr.Key)
			builder.WriteString(`="`)
			builder.WriteString(html.EscapeString(attr.Val))
			builder.WriteByte('"')
		}
		builder.WriteByte('>')
		if topicHTMLVoidElement(node.Data) {
			return
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			renderTopicHTMLNode(builder, child)
		}
		builder.WriteString("</")
		builder.WriteString(node.Data)
		builder.WriteByte('>')
	}
}

func topicHTMLVoidElement(name string) bool {
	return name == "br" || name == "hr" || name == "img"
}
