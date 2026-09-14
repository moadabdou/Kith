package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var (
	ErrDocumentNotFound = errors.New("meilisearch: document not found")
)

// MessageDocument is the search document format indexed in Meilisearch.
type MessageDocument struct {
	ID        string `json:"id"`
	GuildID   string `json:"guild_id"`
	ChannelID string `json:"channel_id"`
	AuthorID  string `json:"author_id"`
	Content   string `json:"content"`
	Timestamp int64  `json:"timestamp"`
}

// MeiliClient is an HTTP client for Meilisearch v1.12.
type MeiliClient struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewMeiliClient initializes a MeiliClient with connection pooling and timeouts.
func NewMeiliClient(baseURL, apiKey string) *MeiliClient {
	baseURL = strings.TrimRight(baseURL, "/")
	return &MeiliClient{
		baseURL: baseURL,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// IndexDocuments upserts a batch of documents into the specified index idempotently.
func (c *MeiliClient) IndexDocuments(ctx context.Context, index string, docs []MessageDocument) error {
	if len(docs) == 0 {
		return nil
	}
	body, err := json.Marshal(docs)
	if err != nil {
		return fmt.Errorf("meilisearch: marshal documents: %w", err)
	}

	url := fmt.Sprintf("%s/indexes/%s/documents?primaryKey=id", c.baseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("meilisearch: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("meilisearch: do request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("meilisearch: index documents failed (status %d): %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// DeleteDocuments deletes a batch of document IDs from the specified index.
func (c *MeiliClient) DeleteDocuments(ctx context.Context, index string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	body, err := json.Marshal(ids)
	if err != nil {
		return fmt.Errorf("meilisearch: marshal delete ids: %w", err)
	}

	url := fmt.Sprintf("%s/indexes/%s/documents/delete-batch", c.baseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("meilisearch: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("meilisearch: do request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("meilisearch: delete documents failed (status %d): %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// GetDocument fetches a single document by ID from the index.
func (c *MeiliClient) GetDocument(ctx context.Context, index, id string) (*MessageDocument, error) {
	url := fmt.Sprintf("%s/indexes/%s/documents/%s", c.baseURL, index, id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("meilisearch: new request: %w", err)
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("meilisearch: do request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrDocumentNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("meilisearch: get document failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var doc MessageDocument
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("meilisearch: decode document: %w", err)
	}
	return &doc, nil
}

// SearchQuery defines parameters for querying Meilisearch.
type SearchQuery struct {
	Query                string   `json:"q"`
	Filter               string   `json:"filter,omitempty"`
	Limit                int      `json:"limit,omitempty"`
	Offset               int      `json:"offset,omitempty"`
	Sort                 []string `json:"sort,omitempty"`
	AttributesToRetrieve []string `json:"attributesToRetrieve,omitempty"`
}

// SearchHit represents a hit returned by Meilisearch.
type SearchHit struct {
	ID        string `json:"id"`
	GuildID   string `json:"guild_id,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	AuthorID  string `json:"author_id,omitempty"`
	Content   string `json:"content,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
}

// SearchResult represents the Meilisearch search response envelope.
type SearchResult struct {
	Hits               []SearchHit `json:"hits"`
	EstimatedTotalHits int         `json:"estimatedTotalHits"`
	Limit              int         `json:"limit"`
	Offset             int         `json:"offset"`
	ProcessingTimeMs   int         `json:"processingTimeMs"`
	Query              string      `json:"query"`
}

// Search executes a search query against the specified index.
// By default, if AttributesToRetrieve is empty, it requests only the "id" field
// to support lightweight retrieval and ScyllaDB hydration ("Search-Index-Only").
func (c *MeiliClient) Search(ctx context.Context, index string, q SearchQuery) (*SearchResult, error) {
	if len(q.AttributesToRetrieve) == 0 {
		q.AttributesToRetrieve = []string{"id"}
	}
	body, err := json.Marshal(q)
	if err != nil {
		return nil, fmt.Errorf("meilisearch: marshal search query: %w", err)
	}

	url := fmt.Sprintf("%s/indexes/%s/search", c.baseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("meilisearch: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("meilisearch: do request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("meilisearch: search failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var res SearchResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("meilisearch: decode search response: %w", err)
	}
	return &res, nil
}
