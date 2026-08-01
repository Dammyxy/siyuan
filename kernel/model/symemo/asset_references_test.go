package symemo

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCollectSMEAssetReferences(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "topic.sme"), []byte(`{"payload":{"material":{"html":"<p><img src=\"assets/shared.png\"></p>"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "item.sme"), []byte(`{"payload":{"prompt":"<p><img src=\"assets/prompt.png\"></p>","answer":"<p><img src=\"assets/shared.png\"></p>"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ignore.txt"), []byte(`assets/ignored.png`), 0600); err != nil {
		t.Fatal(err)
	}

	refs, err := collectSMEAssetReferences(root)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(refs, []string{"assets/prompt.png", "assets/shared.png"}) {
		t.Fatalf("references = %#v", refs)
	}
}

func TestCollectSMEAssetReferencesFailsClosedForMalformedSource(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "broken.sme"), []byte(`{"payload":`), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := collectSMEAssetReferences(root); err == nil {
		t.Fatal("malformed .sme source was treated as an empty reference set")
	}
}

func TestCollectSMEAssetReferencesIgnoresUnsafeAndNonMaterialStrings(t *testing.T) {
	root := t.TempDir()
	source := `{"payload":{"material":{"html":"<p><img src=\"assets/ok.png\"><img src=\"assets/../escape.png\"><img src=\"file:///tmp/secret.png\"><img src=\"data:image/png;base64,AAA\"></p>"},"title":"assets/not-an-image.png"}}`
	if err := os.WriteFile(filepath.Join(root, "item.sme"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}

	refs, err := collectSMEAssetReferences(root)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(refs, []string{"assets/ok.png"}) {
		t.Fatalf("references = %#v", refs)
	}
}
