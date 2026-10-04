package gifs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFallback_Trending(t *testing.T) {
	svc := NewService("", nil, nil)
	ctx := context.Background()

	resp, err := svc.Trending(ctx, 1, 5)
	if err != nil {
		t.Fatalf("Trending returned error: %v", err)
	}

	if len(resp.Results) != 5 {
		t.Fatalf("expected 5 results, got %d", len(resp.Results))
	}
	if !resp.HasNext {
		t.Fatalf("expected has_next to be true for page 1 with limit 5")
	}
	if resp.Results[0].URL == "" {
		t.Errorf("expected result to have a valid URL")
	}
	if resp.Results[0].PreviewURL == "" {
		t.Errorf("expected result to have a valid PreviewURL")
	}
}

func TestFallback_Search(t *testing.T) {
	svc := NewService("", nil, nil)
	ctx := context.Background()

	// Search for 'dance'
	resp, err := svc.Search(ctx, "dance", 1, 10)
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}

	if len(resp.Results) == 0 {
		t.Fatalf("expected at least 1 result for 'dance'")
	}
	found := false
	for _, item := range resp.Results {
		if item.Title == "Dance Party" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected to find 'Dance Party' in search results")
	}
}

func TestGetFallbackAsset(t *testing.T) {
	data, ok := GetFallbackAsset("dance-party.gif")
	if !ok || len(data) == 0 {
		t.Fatalf("expected to find dance-party.gif asset, got ok=%v len=%d", ok, len(data))
	}

	_, notFound := GetFallbackAsset("non-existent.gif")
	if notFound {
		t.Errorf("expected non-existent.gif to return false")
	}
}

func TestFallback_Categories(t *testing.T) {
	svc := NewService("", nil, nil)
	ctx := context.Background()

	cats, err := svc.Categories(ctx)
	if err != nil {
		t.Fatalf("Categories returned error: %v", err)
	}

	if len(cats) < 5 {
		t.Fatalf("expected at least 5 categories, got %d", len(cats))
	}
	if cats[0].Name == "" || cats[0].SearchTerm == "" {
		t.Errorf("expected categories to have Name and SearchTerm")
	}
}

func TestKlipyResponseParsing(t *testing.T) {
	// Sample KLIPY v1 JSON payload
	sampleJSON := []byte(`{
		"result": true,
		"data": {
			"data": [
				{
					"id": 101,
					"title": "Excited Cat",
					"url": "https://cdn.klipy.com/gif/101.gif",
					"previewUrl": "https://cdn.klipy.com/gif/101_small.gif",
					"width": 500,
					"height": 300,
					"files": {
						"gif": {
							"url": "https://cdn.klipy.com/gif/101_full.gif",
							"width": 500,
							"height": 300
						},
						"tinygif": {
							"url": "https://cdn.klipy.com/gif/101_tiny.gif",
							"width": 200,
							"height": 120
						}
					}
				}
			],
			"current_page": 1,
			"per_page": 24,
			"has_next": true
		}
	}`)

	resp, err := parseKlipyResponse(sampleJSON, 1, 24)
	if err != nil {
		t.Fatalf("parseKlipyResponse returned error: %v", err)
	}

	if len(resp.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(resp.Results))
	}
	item := resp.Results[0]
	if item.ID != "101" {
		t.Errorf("expected ID '101', got %s", item.ID)
	}
	if item.Title != "Excited Cat" {
		t.Errorf("expected Title 'Excited Cat', got %s", item.Title)
	}
	if item.URL != "https://cdn.klipy.com/gif/101_full.gif" {
		t.Errorf("expected URL to be full gif url, got %s", item.URL)
	}
	if item.PreviewURL != "https://cdn.klipy.com/gif/101_tiny.gif" {
		t.Errorf("expected PreviewURL to be tiny gif url, got %s", item.PreviewURL)
	}
	if item.Width != 500 || item.Height != 300 {
		t.Errorf("expected dimensions 500x300, got %dx%d", item.Width, item.Height)
	}
	if !resp.HasNext {
		t.Errorf("expected HasNext to be true")
	}
}

func TestKlipyMockServerFetch(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"result": true,
			"data": {
				"data": [
					{
						"id": "server-1",
						"title": "Mock GIF",
						"url": "https://media.klipy.com/1.gif",
						"files": {
							"gif": { "url": "https://media.klipy.com/1.gif", "width": 400, "height": 300 }
						}
					}
				],
				"has_next": false
			}
		}`))
	}))
	defer mockServer.Close()

	svc := NewService("mock-key", nil, mockServer.Client())
	ctx := context.Background()

	resp, err := svc.fetchFromKlipy(ctx, mockServer.URL, 1, 24)
	if err != nil {
		t.Fatalf("fetchFromKlipy failed: %v", err)
	}
	if len(resp.Results) != 1 || resp.Results[0].ID != "server-1" {
		t.Fatalf("unexpected results from mock fetch: %v", resp)
	}
}
