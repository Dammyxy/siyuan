package symemo

import (
	"strings"
	"testing"
)

func TestItemHTMLCleanerMigratesPlainTextAndKeepsManagedAssets(t *testing.T) {
	migrated, err := migrateItemPlainTextHTML("First line\n\nSecond <line>")
	if err != nil {
		t.Fatal(err)
	}
	if migrated != "<p>First line</p><p><br></p><p>Second &lt;line&gt;</p>" {
		t.Fatalf("migrated HTML = %q", migrated)
	}

	cleaned, err := cleanItemHTML(`<p>Before<img src="assets/item-image.png" alt="local">After</p>`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cleaned, `src="assets/item-image.png"`) {
		t.Fatalf("managed asset reference was dropped: %s", cleaned)
	}
}

func TestItemHTMLCleanerTreatsUnknownMarkupInLegacyTextAsText(t *testing.T) {
	cleaned, err := canonicalizeItemHTML("2 < 3 and <line>")
	if err != nil {
		t.Fatal(err)
	}
	if cleaned != "<p>2 &lt; 3 and &lt;line&gt;</p>" {
		t.Fatalf("legacy text was interpreted as HTML: %s", cleaned)
	}
}

func TestItemHTMLCleanerRejectsUnsafeAssetReferences(t *testing.T) {
	for _, input := range []string{
		`<p><img src="../assets/escape.png"></p>`,
		`<p><img src="assets/../escape.png"></p>`,
		`<p><img src="C:/secret.png"></p>`,
		`<p><img src="/tmp/secret.png"></p>`,
		`<p><img src="file:///C:/secret.png"></p>`,
		`<p><img src="data:image/png;base64,AAA"></p>`,
	} {
		if cleaned, err := cleanItemHTML(input); err == nil || cleaned != "" {
			t.Fatalf("unsafe input accepted: html=%q err=%v", cleaned, err)
		}
	}
}

func TestItemHTMLCleanerPreservesDeterministicImageOrder(t *testing.T) {
	cleaned, err := cleanItemHTML(`<p><img src="assets/first.png"><img src="assets/second.png"></p>`)
	if err != nil {
		t.Fatal(err)
	}
	first := strings.Index(cleaned, `src="assets/first.png"`)
	second := strings.Index(cleaned, `src="assets/second.png"`)
	if first < 0 || second < 0 || first >= second {
		t.Fatalf("image order was not preserved: %s", cleaned)
	}
}
