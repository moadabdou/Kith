package media

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Presigned PUT URLs must be minted for the browser-reachable host: browsers
// cannot resolve the container-network endpoint, and SigV4 signs the Host
// header, so the internal endpoint's URL would be both unreachable and
// invalid. minio.New is lazy (no network I/O), so this runs without a store.
func TestPresignedPutURLUsesPublicEndpoint(t *testing.T) {
	st, err := NewMinIOStorage(StorageConfig{
		Endpoint:       "minio:9000",
		AccessKey:      "kithadmin",
		SecretKey:      "kithpassword123",
		PublicEndpoint: "http://localhost:9000",
	})
	if err != nil {
		t.Fatalf("NewMinIOStorage: %v", err)
	}
	u, err := st.PresignedPutURL(context.Background(), "attachments", "attachments/1/2/staged.png", time.Hour)
	if err != nil {
		t.Fatalf("PresignedPutURL: %v", err)
	}
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("parse presigned url: %v", err)
	}
	if parsed.Host != "localhost:9000" {
		t.Fatalf("presigned host = %q, want localhost:9000 (url %s)", parsed.Host, u)
	}
	if !strings.HasPrefix(parsed.Path, "/attachments/attachments/1/2/staged.png") {
		t.Fatalf("presigned path = %q, want bucket/key preserved", parsed.Path)
	}
	if parsed.Query().Get("X-Amz-Signature") == "" {
		t.Fatal("presigned url missing signature")
	}
}

func TestPresignedPutURLFallsBackWithoutPublicEndpoint(t *testing.T) {
	st, err := NewMinIOStorage(StorageConfig{
		Endpoint:  "localhost:9000",
		AccessKey: "kithadmin",
		SecretKey: "kithpassword123",
	})
	if err != nil {
		t.Fatalf("NewMinIOStorage: %v", err)
	}
	if st.publicClient != nil {
		t.Fatal("expected no public client when PublicEndpoint is unset")
	}
	u, err := st.PresignedPutURL(context.Background(), "attachments", "k", time.Hour)
	if err != nil {
		t.Fatalf("PresignedPutURL: %v", err)
	}
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("parse presigned url: %v", err)
	}
	if parsed.Host != "localhost:9000" {
		t.Fatalf("presigned host = %q, want internal endpoint fallback", parsed.Host)
	}
}

func TestSameEndpointDisablesPublicClient(t *testing.T) {
	st, err := NewMinIOStorage(StorageConfig{
		Endpoint:       "minio:9000",
		AccessKey:      "kithadmin",
		SecretKey:      "kithpassword123",
		PublicEndpoint: "minio:9000",
	})
	if err != nil {
		t.Fatalf("NewMinIOStorage: %v", err)
	}
	if st.publicClient != nil {
		t.Fatal("expected no public client when PublicEndpoint equals Endpoint")
	}
}

// Presigned minting must never dial the network: inside the API container
// "localhost" is itself, so a bucket-location lookup would fail there even
// though it succeeds on the host. An unresolvable endpoint proves no lookup
// happens (regression test for the presign 500).
func TestPresignedPutURLNeedsNoNetwork(t *testing.T) {
	st, err := NewMinIOStorage(StorageConfig{
		Endpoint:       "nonexistent.invalid:9000",
		AccessKey:      "kithadmin",
		SecretKey:      "kithpassword123",
		PublicEndpoint: "also-nonexistent.invalid:9000",
	})
	if err != nil {
		t.Fatalf("NewMinIOStorage: %v", err)
	}
	u, err := st.PresignedPutURL(context.Background(), "attachments", "k", time.Hour)
	if err != nil {
		t.Fatalf("PresignedPutURL dialed the network: %v", err)
	}
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("parse presigned url: %v", err)
	}
	if parsed.Host != "also-nonexistent.invalid:9000" {
		t.Fatalf("presigned host = %q, want public endpoint", parsed.Host)
	}
}

func TestNormalizeEndpoint(t *testing.T) {
	cases := map[string]string{
		"localhost:9000":        "localhost:9000",
		"http://localhost:9000": "localhost:9000",
		"https://cdn.example/":  "cdn.example",
		"  minio:9000  ":        "minio:9000",
		"":                      "",
	}
	for in, want := range cases {
		if got := normalizeEndpoint(in); got != want {
			t.Errorf("normalizeEndpoint(%q) = %q, want %q", in, got, want)
		}
	}
}
