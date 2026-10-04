package gifs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultCacheTTL = 1 * time.Hour
	klipyBaseURL    = "https://api.klipy.com/api/v1"
	requestTimeout  = 3 * time.Second
)

type Service struct {
	apiKey     string
	redis      redis.UniversalClient
	httpClient *http.Client
}

func NewService(apiKey string, redis redis.UniversalClient, httpClient *http.Client) *Service {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	}
	return &Service{
		apiKey:     strings.TrimSpace(apiKey),
		redis:      redis,
		httpClient: httpClient,
	}
}

// Trending fetches popular GIFs, checking Redis cache first.
func (s *Service) Trending(ctx context.Context, page, perPage int) (*GIFResponse, error) {
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 || perPage > 50 {
		perPage = 24
	}

	cacheKey := fmt.Sprintf("gifs:trending:page:%d:limit:%d", page, perPage)
	if resp := s.getFromCache(ctx, cacheKey); resp != nil {
		return resp, nil
	}

	var resp *GIFResponse
	var err error

	if s.apiKey != "" {
		endpoint := fmt.Sprintf("%s/%s/gifs/trending?page=%d&per_page=%d", klipyBaseURL, s.apiKey, page, perPage)
		resp, err = s.fetchFromKlipy(ctx, endpoint, page, perPage)
		if err != nil {
			slog.Warn("klipy trending fetch failed, falling back to local catalog", "error", err)
		}
	}

	if resp == nil {
		resp = getFallbackGIFs("", page, perPage)
	}

	s.saveToCache(ctx, cacheKey, resp)
	return resp, nil
}

// Search searches GIFs by query keywords, checking Redis cache first.
func (s *Service) Search(ctx context.Context, query string, page, perPage int) (*GIFResponse, error) {
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 || perPage > 50 {
		perPage = 24
	}
	trimmedQuery := strings.TrimSpace(query)
	if trimmedQuery == "" {
		return s.Trending(ctx, page, perPage)
	}

	qHash := hashString(strings.ToLower(trimmedQuery))
	cacheKey := fmt.Sprintf("gifs:search:%s:page:%d:limit:%d", qHash, page, perPage)
	if resp := s.getFromCache(ctx, cacheKey); resp != nil {
		return resp, nil
	}

	var resp *GIFResponse
	var err error

	if s.apiKey != "" {
		endpoint := fmt.Sprintf("%s/%s/gifs/search?q=%s&page=%d&per_page=%d", klipyBaseURL, s.apiKey, url.QueryEscape(trimmedQuery), page, perPage)
		resp, err = s.fetchFromKlipy(ctx, endpoint, page, perPage)
		if err != nil {
			slog.Warn("klipy search fetch failed, falling back to local catalog", "query", trimmedQuery, "error", err)
		}
	}

	if resp == nil {
		resp = getFallbackGIFs(trimmedQuery, page, perPage)
	}

	s.saveToCache(ctx, cacheKey, resp)
	return resp, nil
}

// Categories returns the trending suggestion categories.
func (s *Service) Categories(ctx context.Context) ([]GIFCategory, error) {
	const cacheKey = "gifs:categories"
	if s.redis != nil {
		val, err := s.redis.Get(ctx, cacheKey).Result()
		if err == nil && val != "" {
			var cats []GIFCategory
			if err := json.Unmarshal([]byte(val), &cats); err == nil {
				return cats, nil
			}
		}
	}

	cats := getFallbackCategories()
	if s.redis != nil {
		if raw, err := json.Marshal(cats); err == nil {
			_ = s.redis.Set(ctx, cacheKey, raw, defaultCacheTTL).Err()
		}
	}
	return cats, nil
}

func (s *Service) getFromCache(ctx context.Context, key string) *GIFResponse {
	if s.redis == nil {
		return nil
	}
	val, err := s.redis.Get(ctx, key).Result()
	if err != nil || val == "" {
		return nil
	}

	var resp GIFResponse
	if err := json.Unmarshal([]byte(val), &resp); err != nil {
		return nil
	}
	return &resp
}

func (s *Service) saveToCache(ctx context.Context, key string, resp *GIFResponse) {
	if s.redis == nil || resp == nil {
		return
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_ = s.redis.Set(ctx, key, raw, defaultCacheTTL).Err()
}

func (s *Service) fetchFromKlipy(ctx context.Context, reqURL string, page, perPage int) (*GIFResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Kith-Discord-Clone/1.0")

	res, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return nil, fmt.Errorf("klipy returned status %d: %s", res.StatusCode, string(body))
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}

	return parseKlipyResponse(body, page, perPage)
}

func parseKlipyResponse(body []byte, page, perPage int) (*GIFResponse, error) {
	// Structure 1: KLIPY native envelope { "result": true, "data": { "data": [ ... ], "has_next": true } }
	var klipyEnvelope struct {
		Result bool `json:"result"`
		Data   struct {
			Data []struct {
				ID         any    `json:"id"`
				Title      string `json:"title"`
				URL        string `json:"url"`
				PreviewURL string `json:"previewUrl"`
				Width      int    `json:"width"`
				Height     int    `json:"height"`
				Files      struct {
					GIF struct {
						URL    string `json:"url"`
						Width  int    `json:"width"`
						Height int    `json:"height"`
					} `json:"gif"`
					MediumGIF struct {
						URL    string `json:"url"`
						Width  int    `json:"width"`
						Height int    `json:"height"`
					} `json:"mediumgif"`
					TinyGIF struct {
						URL    string `json:"url"`
						Width  int    `json:"width"`
						Height int    `json:"height"`
					} `json:"tinygif"`
				} `json:"files"`
			} `json:"data"`
			CurrentPage int  `json:"current_page"`
			PerPage     int  `json:"per_page"`
			HasNext     bool `json:"has_next"`
		} `json:"data"`
		// Structure 2: Tenor compatibility envelope { "results": [ ... ], "next": "..." }
		Results []struct {
			ID           string `json:"id"`
			Title        string `json:"title"`
			ItemURL      string `json:"itemurl"`
			URL          string `json:"url"`
			MediaFormats struct {
				GIF struct {
					URL  string `json:"url"`
					Dims []int  `json:"dims"`
				} `json:"gif"`
				TinyGIF struct {
					URL  string `json:"url"`
					Dims []int  `json:"dims"`
				} `json:"tinygif"`
			} `json:"media_formats"`
		} `json:"results"`
		Next string `json:"next"`
	}

	if err := json.Unmarshal(body, &klipyEnvelope); err != nil {
		return nil, fmt.Errorf("failed to unmarshal klipy response: %w", err)
	}

	var results []GIFItem

	// Check KLIPY native format
	if len(klipyEnvelope.Data.Data) > 0 {
		for _, d := range klipyEnvelope.Data.Data {
			gifURL := d.Files.GIF.URL
			if gifURL == "" {
				gifURL = d.Files.MediumGIF.URL
			}
			if gifURL == "" {
				gifURL = d.URL
			}
			if gifURL == "" {
				continue
			}

			previewURL := d.Files.TinyGIF.URL
			if previewURL == "" {
				previewURL = d.PreviewURL
			}
			if previewURL == "" {
				previewURL = gifURL
			}

			w := d.Files.GIF.Width
			if w <= 0 {
				w = d.Width
			}
			if w <= 0 {
				w = 498
			}

			h := d.Files.GIF.Height
			if h <= 0 {
				h = d.Height
			}
			if h <= 0 {
				h = 280
			}

			results = append(results, GIFItem{
				ID:         fmt.Sprintf("%v", d.ID),
				Title:      d.Title,
				URL:        gifURL,
				PreviewURL: previewURL,
				Width:      w,
				Height:     h,
			})
		}

		hasNext := klipyEnvelope.Data.HasNext
		if !hasNext && len(results) >= perPage {
			hasNext = true
		}
		var nextToken string
		if hasNext {
			nextToken = strconv.Itoa(page + 1)
		}

		return &GIFResponse{
			Results: results,
			Page:    page,
			HasNext: hasNext,
			Next:    nextToken,
		}, nil
	}

	// Check Tenor compatibility format
	if len(klipyEnvelope.Results) > 0 {
		for _, r := range klipyEnvelope.Results {
			gifURL := r.MediaFormats.GIF.URL
			if gifURL == "" {
				gifURL = r.URL
			}
			if gifURL == "" {
				gifURL = r.ItemURL
			}
			if gifURL == "" {
				continue
			}

			previewURL := r.MediaFormats.TinyGIF.URL
			if previewURL == "" {
				previewURL = gifURL
			}

			w := 498
			h := 280
			if len(r.MediaFormats.GIF.Dims) >= 2 {
				w = r.MediaFormats.GIF.Dims[0]
				h = r.MediaFormats.GIF.Dims[1]
			}

			results = append(results, GIFItem{
				ID:         r.ID,
				Title:      r.Title,
				URL:        gifURL,
				PreviewURL: previewURL,
				Width:      w,
				Height:     h,
			})
		}

		hasNext := klipyEnvelope.Next != "" || len(results) >= perPage
		return &GIFResponse{
			Results: results,
			Page:    page,
			HasNext: hasNext,
			Next:    klipyEnvelope.Next,
		}, nil
	}

	return &GIFResponse{
		Results: []GIFItem{},
		Page:    page,
		HasNext: false,
	}, nil
}

func hashString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}
