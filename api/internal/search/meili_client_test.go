package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMeiliClient_EnsureSchema(t *testing.T) {
	var checkedIndex bool
	var createdIndex bool
	var patchedSettings bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/indexes/messages":
			checkedIndex = true
			http.NotFound(w, r)
		case r.Method == http.MethodPost && r.URL.Path == "/indexes":
			createdIndex = true
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("bad create index body: %v", err)
			}
			if body["uid"] != "messages" || body["primaryKey"] != "id" {
				t.Fatalf("unexpected create index body: %+v", body)
			}
			w.WriteHeader(http.StatusAccepted)
		case r.Method == http.MethodPatch && r.URL.Path == "/indexes/messages/settings":
			patchedSettings = true
			var s IndexSettings
			if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
				t.Fatalf("bad settings body: %v", err)
			}
			if len(s.FilterableAttributes) == 0 || len(s.SortableAttributes) == 0 {
				t.Fatalf("missing attributes in settings: %+v", s)
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewMeiliClient(server.URL, "test-key")
	err := client.EnsureSchema(context.Background(), "messages")
	if err != nil {
		t.Fatalf("EnsureSchema failed: %v", err)
	}

	if !checkedIndex {
		t.Errorf("expected index check")
	}
	if !createdIndex {
		t.Errorf("expected index creation")
	}
	if !patchedSettings {
		t.Errorf("expected settings patch")
	}
}
