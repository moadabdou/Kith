package gifs

import (
	"embed"
	"path/filepath"
	"strings"
)

//go:embed assets/*.gif
var fallbackAssetsFS embed.FS

// GetFallbackAsset retrieves an embedded fallback GIF by filename.
func GetFallbackAsset(name string) ([]byte, bool) {
	clean := filepath.Base(name)
	data, err := fallbackAssetsFS.ReadFile("assets/" + clean)
	if err != nil {
		return nil, false
	}
	return data, true
}

var defaultCategories = []GIFCategory{
	{
		Name:       "Excited",
		SearchTerm: "excited",
		PreviewURL: "/api/gifs/fallback/excited-happy.gif",
	},
	{
		Name:       "Laughing",
		SearchTerm: "laughing",
		PreviewURL: "/api/gifs/fallback/laughing-lol.gif",
	},
	{
		Name:       "Dance",
		SearchTerm: "dance",
		PreviewURL: "/api/gifs/fallback/dance-party.gif",
	},
	{
		Name:       "Facepalm",
		SearchTerm: "facepalm",
		PreviewURL: "/api/gifs/fallback/facepalm-star-trek.gif",
	},
	{
		Name:       "Applause",
		SearchTerm: "applause",
		PreviewURL: "/api/gifs/fallback/applause-clapping.gif",
	},
	{
		Name:       "Sad",
		SearchTerm: "sad",
		PreviewURL: "/api/gifs/fallback/sad-crying.gif",
	},
	{
		Name:       "Thumbs Up",
		SearchTerm: "thumbs up",
		PreviewURL: "/api/gifs/fallback/thumbs-up-good.gif",
	},
	{
		Name:       "Party",
		SearchTerm: "party",
		PreviewURL: "/api/gifs/fallback/party-confetti.gif",
	},
	{
		Name:       "Cat",
		SearchTerm: "cat",
		PreviewURL: "/api/gifs/fallback/cat-cute.gif",
	},
	{
		Name:       "Shocked",
		SearchTerm: "shocked",
		PreviewURL: "/api/gifs/fallback/shocked-surprised.gif",
	},
}

var fallbackCatalog = []struct {
	item GIFItem
	tags []string
}{
	{
		item: GIFItem{
			ID:         "fb-1",
			Title:      "Excited",
			URL:        "/api/gifs/fallback/excited-happy.gif",
			PreviewURL: "/api/gifs/fallback/excited-happy.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"excited", "happy", "yes", "cheering", "yay"},
	},
	{
		item: GIFItem{
			ID:         "fb-2",
			Title:      "Laughing",
			URL:        "/api/gifs/fallback/laughing-lol.gif",
			PreviewURL: "/api/gifs/fallback/laughing-lol.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"laughing", "lol", "haha", "funny", "joke"},
	},
	{
		item: GIFItem{
			ID:         "fb-3",
			Title:      "Dance Party",
			URL:        "/api/gifs/fallback/dance-party.gif",
			PreviewURL: "/api/gifs/fallback/dance-party.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"dance", "party", "groove", "music"},
	},
	{
		item: GIFItem{
			ID:         "fb-4",
			Title:      "Facepalm",
			URL:        "/api/gifs/fallback/facepalm-star-trek.gif",
			PreviewURL: "/api/gifs/fallback/facepalm-star-trek.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"facepalm", "disappointed", "fail", "smh"},
	},
	{
		item: GIFItem{
			ID:         "fb-5",
			Title:      "Applause",
			URL:        "/api/gifs/fallback/applause-clapping.gif",
			PreviewURL: "/api/gifs/fallback/applause-clapping.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"applause", "clapping", "bravo", "good job", "congrats"},
	},
	{
		item: GIFItem{
			ID:         "fb-6",
			Title:      "Sad Crying",
			URL:        "/api/gifs/fallback/sad-crying.gif",
			PreviewURL: "/api/gifs/fallback/sad-crying.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"sad", "crying", "tears", "no"},
	},
	{
		item: GIFItem{
			ID:         "fb-7",
			Title:      "Thumbs Up",
			URL:        "/api/gifs/fallback/thumbs-up-good.gif",
			PreviewURL: "/api/gifs/fallback/thumbs-up-good.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"thumbs up", "good", "nice", "ok", "agree"},
	},
	{
		item: GIFItem{
			ID:         "fb-8",
			Title:      "Party Confetti",
			URL:        "/api/gifs/fallback/party-confetti.gif",
			PreviewURL: "/api/gifs/fallback/party-confetti.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"party", "confetti", "celebration", "happy", "disco"},
	},
	{
		item: GIFItem{
			ID:         "fb-9",
			Title:      "Cute Cat",
			URL:        "/api/gifs/fallback/cat-cute.gif",
			PreviewURL: "/api/gifs/fallback/cat-cute.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"cat", "cute", "vibe", "kitten", "pet"},
	},
	{
		item: GIFItem{
			ID:         "fb-10",
			Title:      "Shocked Surprised",
			URL:        "/api/gifs/fallback/shocked-surprised.gif",
			PreviewURL: "/api/gifs/fallback/shocked-surprised.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"shocked", "surprised", "wow", "omg"},
	},
	{
		item: GIFItem{
			ID:         "fb-11",
			Title:      "Confused Dog",
			URL:        "/api/gifs/fallback/dog-confused.gif",
			PreviewURL: "/api/gifs/fallback/dog-confused.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"dog", "confused", "cute", "puppy", "what"},
	},
	{
		item: GIFItem{
			ID:         "fb-12",
			Title:      "Popcorn Eating",
			URL:        "/api/gifs/fallback/popcorn-eating.gif",
			PreviewURL: "/api/gifs/fallback/popcorn-eating.gif",
			Width:      320,
			Height:     240,
		},
		tags: []string{"popcorn", "drama", "watching", "eating", "snack"},
	},
}

func getFallbackCategories() []GIFCategory {
	return defaultCategories
}

func getFallbackGIFs(query string, page, perPage int) *GIFResponse {
	if page <= 0 {
		page = 1
	}
	if perPage <= 0 || perPage > 50 {
		perPage = 24
	}

	q := strings.ToLower(strings.TrimSpace(query))
	var matched []GIFItem

	if q == "" {
		for _, entry := range fallbackCatalog {
			matched = append(matched, entry.item)
		}
	} else {
		for _, entry := range fallbackCatalog {
			hit := strings.Contains(strings.ToLower(entry.item.Title), q)
			if !hit {
				for _, t := range entry.tags {
					if strings.Contains(t, q) || strings.Contains(q, t) {
						hit = true
						break
					}
				}
			}
			if hit {
				matched = append(matched, entry.item)
			}
		}
		// If query didn't match specific tags, fall back to entire catalog rather than empty
		if len(matched) == 0 {
			for _, entry := range fallbackCatalog {
				matched = append(matched, entry.item)
			}
		}
	}

	total := len(matched)
	startIndex := (page - 1) * perPage
	if startIndex >= total {
		return &GIFResponse{
			Results: []GIFItem{},
			Page:    page,
			HasNext: false,
		}
	}

	endIndex := startIndex + perPage
	hasNext := true
	if endIndex >= total {
		endIndex = total
		hasNext = false
	}

	var nextToken string
	if hasNext {
		nextToken = string(rune('0' + page + 1))
	}

	return &GIFResponse{
		Results: matched[startIndex:endIndex],
		Page:    page,
		HasNext: hasNext,
		Next:    nextToken,
	}
}
