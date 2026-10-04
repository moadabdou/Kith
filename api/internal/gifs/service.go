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
	requestTimeout  = 12 * time.Second
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

	if s.apiKey != "" {
		endpoint := fmt.Sprintf("%s/%s/gifs/trending?page=%d&per_page=%d", klipyBaseURL, s.apiKey, page, perPage)
		resp, err := s.fetchFromKlipy(ctx, endpoint, page, perPage)
		if err != nil {
			slog.Warn("klipy trending fetch failed, falling back to local catalog", "error", err)
		} else if resp != nil {
			s.saveToCache(ctx, cacheKey, resp)
			return resp, nil
		}
	}

	return getFallbackGIFs("", page, perPage), nil
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

	if s.apiKey != "" {
		endpoint := fmt.Sprintf("%s/%s/gifs/search?q=%s&page=%d&per_page=%d", klipyBaseURL, s.apiKey, url.QueryEscape(trimmedQuery), page, perPage)
		resp, err := s.fetchFromKlipy(ctx, endpoint, page, perPage)
		if err != nil {
			slog.Warn("klipy search fetch failed, falling back to local catalog", "query", trimmedQuery, "error", err)
		} else if resp != nil {
			s.saveToCache(ctx, cacheKey, resp)
			return resp, nil
		}
	}

	return getFallbackGIFs(trimmedQuery, page, perPage), nil
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

	var cats []GIFCategory
	if s.apiKey != "" {
		endpoint := fmt.Sprintf("%s/%s/gifs/categories", klipyBaseURL, s.apiKey)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err == nil {
			res, err := s.httpClient.Do(req)
			if err == nil {
				defer res.Body.Close()
				if res.StatusCode == http.StatusOK {
					var catResp struct {
						Result bool `json:"result"`
						Data   struct {
							Categories []struct {
								Category   string `json:"category"`
								Query      string `json:"query"`
								PreviewURL string `json:"preview_url"`
							} `json:"categories"`
						} `json:"data"`
					}
					if err := json.NewDecoder(res.Body).Decode(&catResp); err == nil && len(catResp.Data.Categories) > 0 {
						for _, c := range catResp.Data.Categories {
							title := strings.ToUpper(c.Category[:1]) + c.Category[1:]
							cats = append(cats, GIFCategory{
								Name:       title,
								SearchTerm: c.Query,
								PreviewURL: c.PreviewURL,
							})
						}
					}
				}
			}
		}
	}

	if len(cats) == 0 {
		cats = getFallbackCategories()
	}

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

type klipyFileFormat struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type klipyFileGroup struct {
	GIF  klipyFileFormat `json:"gif"`
	WebP klipyFileFormat `json:"webp"`
	JPG  klipyFileFormat `json:"jpg"`
	MP4  klipyFileFormat `json:"mp4"`
}

type klipyItem struct {
	ID    any    `json:"id"`
	Slug  string `json:"slug"`
	Title string `json:"title"`
	URL   string `json:"url"`
	File  struct {
		HD klipyFileGroup `json:"hd"`
		MD klipyFileGroup `json:"md"`
		SM klipyFileGroup `json:"sm"`
		XS klipyFileGroup `json:"xs"`
	} `json:"file"`
}

func (k *klipyItem) toGIFItem() GIFItem {
	fullURL := k.File.MD.GIF.URL
	w := k.File.MD.GIF.Width
	h := k.File.MD.GIF.Height
	if fullURL == "" {
		fullURL = k.File.HD.GIF.URL
		w = k.File.HD.GIF.Width
		h = k.File.HD.GIF.Height
	}
	if fullURL == "" {
		fullURL = k.File.SM.GIF.URL
		w = k.File.SM.GIF.Width
		h = k.File.SM.GIF.Height
	}
	if fullURL == "" {
		fullURL = k.URL
	}

	prevURL := k.File.SM.GIF.URL
	if prevURL == "" {
		prevURL = k.File.XS.GIF.URL
	}
	if prevURL == "" {
		prevURL = fullURL
	}

	idStr := fmt.Sprintf("%v", k.ID)
	if idStr == "" || idStr == "<nil>" {
		idStr = k.Slug
	}

	title := k.Title
	if title == "" {
		title = k.Slug
	}

	return GIFItem{
		ID:         idStr,
		Title:      title,
		URL:        fullURL,
		PreviewURL: prevURL,
		Width:      w,
		Height:     h,
	}
}

func parseKlipyResponse(body []byte, page, perPage int) (*GIFResponse, error) {
	// Format 1: trending response where "data" is a list: { "result": true, "data": [ ... ], "has_next": true }
	var listResp struct {
		Result      bool        `json:"result"`
		Data        []klipyItem `json:"data"`
		CurrentPage int         `json:"current_page"`
		PerPage     int         `json:"per_page"`
		HasNext     bool        `json:"has_next"`
	}
	if err := json.Unmarshal(body, &listResp); err == nil && len(listResp.Data) > 0 {
		var results []GIFItem
		for _, item := range listResp.Data {
			g := item.toGIFItem()
			if g.URL != "" {
				results = append(results, g)
			}
		}
		if len(results) > 0 {
			var nextToken string
			if listResp.HasNext {
				nextToken = strconv.Itoa(page + 1)
			}
			return &GIFResponse{
				Results: results,
				Page:    page,
				HasNext: listResp.HasNext,
				Next:    nextToken,
			}, nil
		}
	}

	// Format 2: search response where "data" is an object: { "result": true, "data": { "data": [ ... ], "has_next": true } }
	var searchResp struct {
		Result bool `json:"result"`
		Data   struct {
			Data        []klipyItem `json:"data"`
			CurrentPage int         `json:"current_page"`
			PerPage     int         `json:"per_page"`
			HasNext     bool        `json:"has_next"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &searchResp); err == nil && len(searchResp.Data.Data) > 0 {
		var results []GIFItem
		for _, item := range searchResp.Data.Data {
			g := item.toGIFItem()
			if g.URL != "" {
				results = append(results, g)
			}
		}
		if len(results) > 0 {
			var nextToken string
			if searchResp.Data.HasNext {
				nextToken = strconv.Itoa(page + 1)
			}
			return &GIFResponse{
				Results: results,
				Page:    page,
				HasNext: searchResp.Data.HasNext,
				Next:    nextToken,
			}, nil
		}
	}

	return getFallbackGIFs("", page, perPage), nil
}

func hashString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}
