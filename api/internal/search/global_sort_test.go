package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

// TestGlobalChronologicalSearch tests how Meilisearch handles chronological sorting
// across pagination pages when ranking rules prioritize text-relevance vs sort.
func TestGlobalChronologicalSearch(t *testing.T) {
	baseURL := "http://localhost:7700"
	apiKey := "dev-master-key"

	// Check if Meilisearch is reachable
	resp, err := http.Get(baseURL + "/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Skip("Meilisearch server not reachable at http://localhost:7700, skipping live integration test")
		return
	}
	resp.Body.Close()

	httpClient := &http.Client{Timeout: 5 * time.Second}

	// Helper to send authenticated Meilisearch requests
	sendMeiliReq := func(method, path string, body any) ([]byte, int, error) {
		var bodyReader io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				return nil, 0, err
			}
			bodyReader = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, baseURL+path, bodyReader)
		if err != nil {
			return nil, 0, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		res, err := httpClient.Do(req)
		if err != nil {
			return nil, 0, err
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		return data, res.StatusCode, err
	}

	waitForTask := func(taskUID int64) error {
		for i := 0; i < 30; i++ {
			data, _, err := sendMeiliReq(http.MethodGet, fmt.Sprintf("/tasks/%d", taskUID), nil)
			if err != nil {
				return err
			}
			var task struct {
				Status string `json:"status"`
			}
			if err := json.Unmarshal(data, &task); err == nil {
				if task.Status == "succeeded" {
					return nil
				}
				if task.Status == "failed" {
					return fmt.Errorf("task failed: %s", string(data))
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		return fmt.Errorf("task %d timed out", taskUID)
	}

	// 4 test messages with varying keyword frequency vs timestamp:
	// Doc 1: Timestamp 1000, Content: "deploy alert" (Oldest, 1 keyword)
	// Doc 2: Timestamp 2000, Content: "deploy deploy deploy" (Older, 3 keywords -> Highest Text Relevance)
	// Doc 3: Timestamp 4000, Content: "deploy" (Newest, 1 keyword)
	// Doc 4: Timestamp 3000, Content: "deploy deploy" (Second newest, 2 keywords)
	testDocs := []MessageDocument{
		{ID: "1001", GuildID: "999", ChannelID: "1", AuthorID: "10", Content: "deploy alert", Timestamp: 1000},
		{ID: "1002", GuildID: "999", ChannelID: "1", AuthorID: "10", Content: "deploy deploy deploy", Timestamp: 2000},
		{ID: "1003", GuildID: "999", ChannelID: "1", AuthorID: "10", Content: "deploy", Timestamp: 4000},
		{ID: "1004", GuildID: "999", ChannelID: "1", AuthorID: "10", Content: "deploy deploy", Timestamp: 3000},
	}

	// ── CASE A: Default Meilisearch Ranking Rules ───────────────
	// Default rules: ["words", "typo", "proximity", "attribute", "sort", "exactness"]
	t.Run("Case A: Default Meilisearch Ranking (Relevance over Sort)", func(t *testing.T) {
		indexA := fmt.Sprintf("test_default_rank_%d", time.Now().UnixNano())
		defer func() {
			_, _, _ = sendMeiliReq(http.MethodDelete, "/indexes/"+indexA, nil)
		}()

		// Create index with sortableAttributes: ["timestamp"] and filterableAttributes
		settingsA := map[string]any{
			"filterableAttributes": []string{"guild_id", "channel_id", "author_id", "timestamp"},
			"sortableAttributes":   []string{"timestamp"},
			"rankingRules":         []string{"words", "typo", "proximity", "attribute", "sort", "exactness"},
		}
		data, _, err := sendMeiliReq(http.MethodPost, "/indexes", map[string]any{"uid": indexA, "primaryKey": "id"})
		if err != nil {
			t.Fatalf("create index failed: %v", err)
		}
		var taskResp struct {
			TaskUID int64 `json:"taskUid"`
		}
		_ = json.Unmarshal(data, &taskResp)
		_ = waitForTask(taskResp.TaskUID)

		data, _, err = sendMeiliReq(http.MethodPatch, fmt.Sprintf("/indexes/%s/settings", indexA), settingsA)
		if err != nil {
			t.Fatalf("set settings failed: %v", err)
		}
		_ = json.Unmarshal(data, &taskResp)
		_ = waitForTask(taskResp.TaskUID)

		// Index test documents
		data, _, err = sendMeiliReq(http.MethodPost, fmt.Sprintf("/indexes/%s/documents", indexA), testDocs)
		if err != nil {
			t.Fatalf("index docs failed: %v", err)
		}
		_ = json.Unmarshal(data, &taskResp)
		_ = waitForTask(taskResp.TaskUID)

		// Query Page 1 with limit=2, sort=["timestamp:desc"]
		client := NewMeiliClient(baseURL, apiKey)
		page1, err := client.Search(context.Background(), indexA, SearchQuery{
			Query:  "deploy",
			Filter: "guild_id = '999'",
			Limit:  2,
			Offset: 0,
			Sort:   []string{"timestamp:desc"},
		})
		if err != nil {
			t.Fatalf("search page 1 failed: %v", err)
		}

		t.Logf("Case A (Default) Page 1 IDs: %v", []string{page1.Hits[0].ID, page1.Hits[1].ID})

		// Because Meilisearch default ranking puts "words" before "sort",
		// Doc 1002 ("deploy deploy deploy") ranks first due to keyword density,
		// despite being older than Doc 1003 (ts 4000) and Doc 1004 (ts 3000)!
		if page1.Hits[0].ID == "1002" {
			t.Logf("Confirmed: Default Meilisearch ranking puts highest keyword density (Doc 1002) ahead of newer messages!")
		}
	})

	// ── CASE B: Chronological-First Ranking Rules (Discord Behavior) ────
	// Ranking rules: ["sort", "words", "typo", "proximity", "attribute", "exactness"]
	t.Run("Case B: Chronological-First Ranking (Sort over Words)", func(t *testing.T) {
		indexB := fmt.Sprintf("test_chrono_rank_%d", time.Now().UnixNano())
		defer func() {
			_, _, _ = sendMeiliReq(http.MethodDelete, "/indexes/"+indexB, nil)
		}()

		// Create index with sort placed FIRST in rankingRules
		settingsB := map[string]any{
			"filterableAttributes": []string{"guild_id", "channel_id", "author_id", "timestamp"},
			"sortableAttributes":   []string{"timestamp"},
			"rankingRules":         []string{"sort", "words", "typo", "proximity", "attribute", "exactness"},
		}
		data, _, err := sendMeiliReq(http.MethodPost, "/indexes", map[string]any{"uid": indexB, "primaryKey": "id"})
		if err != nil {
			t.Fatalf("create index failed: %v", err)
		}
		var taskResp struct {
			TaskUID int64 `json:"taskUid"`
		}
		_ = json.Unmarshal(data, &taskResp)
		_ = waitForTask(taskResp.TaskUID)

		data, _, err = sendMeiliReq(http.MethodPatch, fmt.Sprintf("/indexes/%s/settings", indexB), settingsB)
		if err != nil {
			t.Fatalf("set settings failed: %v", err)
		}
		_ = json.Unmarshal(data, &taskResp)
		_ = waitForTask(taskResp.TaskUID)

		// Index test documents
		data, _, err = sendMeiliReq(http.MethodPost, fmt.Sprintf("/indexes/%s/documents", indexB), testDocs)
		if err != nil {
			t.Fatalf("index docs failed: %v", err)
		}
		_ = json.Unmarshal(data, &taskResp)
		_ = waitForTask(taskResp.TaskUID)

		client := NewMeiliClient(baseURL, apiKey)

		// Page 1 (limit: 2, offset: 0)
		page1, err := client.Search(context.Background(), indexB, SearchQuery{
			Query:  "deploy",
			Filter: "guild_id = '999'",
			Limit:  2,
			Offset: 0,
			Sort:   []string{"timestamp:desc"},
		})
		if err != nil {
			t.Fatalf("search page 1 failed: %v", err)
		}

		// Page 2 (limit: 2, offset: 2)
		page2, err := client.Search(context.Background(), indexB, SearchQuery{
			Query:  "deploy",
			Filter: "guild_id = '999'",
			Limit:  2,
			Offset: 2,
			Sort:   []string{"timestamp:desc"},
		})
		if err != nil {
			t.Fatalf("search page 2 failed: %v", err)
		}

		t.Logf("Case B (Chrono-First) Page 1 IDs: %v", []string{page1.Hits[0].ID, page1.Hits[1].ID})
		t.Logf("Case B (Chrono-First) Page 2 IDs: %v", []string{page2.Hits[0].ID, page2.Hits[1].ID})

		// In Case B, results across BOTH pages must be strictly descending by timestamp:
		// Page 1: 1003 (ts 4000), 1004 (ts 3000)
		// Page 2: 1002 (ts 2000), 1001 (ts 1000)
		if page1.Hits[0].ID != "1003" || page1.Hits[1].ID != "1004" {
			t.Fatalf("expected Page 1 to be [1003, 1004], got [%s, %s]", page1.Hits[0].ID, page1.Hits[1].ID)
		}
		if page2.Hits[0].ID != "1002" || page2.Hits[1].ID != "1001" {
			t.Fatalf("expected Page 2 to be [1002, 1001], got [%s, %s]", page2.Hits[0].ID, page2.Hits[1].ID)
		}

		t.Log("SUCCESS: Results across pages are strictly globally chronological (4000 > 3000 > 2000 > 1000)!")
	})
}
