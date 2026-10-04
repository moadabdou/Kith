package gifs

import (
	"strings"
)

var defaultCategories = []GIFCategory{
	{
		Name:       "Excited",
		SearchTerm: "excited",
		PreviewURL: "https://media.tenor.com/2roX3uxz_68AAAAM/excited-happy.gif",
	},
	{
		Name:       "Laughing",
		SearchTerm: "laughing",
		PreviewURL: "https://media.tenor.com/W2h0e3kH92YAAAAM/laughing-lol.gif",
	},
	{
		Name:       "Dance",
		SearchTerm: "dance",
		PreviewURL: "https://media.tenor.com/XkO7bU3a3dAAAAAM/dance-party.gif",
	},
	{
		Name:       "Facepalm",
		SearchTerm: "facepalm",
		PreviewURL: "https://media.tenor.com/kHyrxsmcLDEAAAAM/facepalm-star-trek.gif",
	},
	{
		Name:       "Applause",
		SearchTerm: "applause",
		PreviewURL: "https://media.tenor.com/1B-C3a4G5gEAAAAM/applause-clapping.gif",
	},
	{
		Name:       "Sad",
		SearchTerm: "sad",
		PreviewURL: "https://media.tenor.com/O6S4Fw28bZcAAAAM/sad-crying.gif",
	},
	{
		Name:       "Thumbs Up",
		SearchTerm: "thumbs up",
		PreviewURL: "https://media.tenor.com/93Kq_d6k5HkAAAAM/thumbs-up-good.gif",
	},
	{
		Name:       "Party",
		SearchTerm: "party",
		PreviewURL: "https://media.tenor.com/PZcI9f2c3XIAAAAM/party-confetti.gif",
	},
	{
		Name:       "Cat",
		SearchTerm: "cat",
		PreviewURL: "https://media.tenor.com/N18x2fR3yHwAAAAM/cat-cute.gif",
	},
	{
		Name:       "Shocked",
		SearchTerm: "shocked",
		PreviewURL: "https://media.tenor.com/Qh1P-k4V404AAAAM/shocked-surprised.gif",
	},
}

var fallbackCatalog = []struct {
	item GIFItem
	tags []string
}{
	{
		item: GIFItem{
			ID:         "fb-1",
			Title:      "Excited Minion",
			URL:        "https://media.tenor.com/2roX3uxz_68AAAAC/excited-happy.gif",
			PreviewURL: "https://media.tenor.com/2roX3uxz_68AAAAM/excited-happy.gif",
			Width:      498,
			Height:     280,
		},
		tags: []string{"excited", "happy", "yes", "cheering", "yay"},
	},
	{
		item: GIFItem{
			ID:         "fb-2",
			Title:      "Laughing Leonardo DiCaprio",
			URL:        "https://media.tenor.com/W2h0e3kH92YAAAAC/laughing-lol.gif",
			PreviewURL: "https://media.tenor.com/W2h0e3kH92YAAAAM/laughing-lol.gif",
			Width:      498,
			Height:     278,
		},
		tags: []string{"laughing", "lol", "haha", "funny", "joke"},
	},
	{
		item: GIFItem{
			ID:         "fb-3",
			Title:      "Carlton Dance",
			URL:        "https://media.tenor.com/XkO7bU3a3dAAAAAC/dance-party.gif",
			PreviewURL: "https://media.tenor.com/XkO7bU3a3dAAAAAM/dance-party.gif",
			Width:      498,
			Height:     374,
		},
		tags: []string{"dance", "carlton", "groove", "music", "party"},
	},
	{
		item: GIFItem{
			ID:         "fb-4",
			Title:      "Captain Picard Facepalm",
			URL:        "https://media.tenor.com/kHyrxsmcLDEAAAAC/facepalm-star-trek.gif",
			PreviewURL: "https://media.tenor.com/kHyrxsmcLDEAAAAM/facepalm-star-trek.gif",
			Width:      498,
			Height:     374,
		},
		tags: []string{"facepalm", "disappointed", "star trek", "fail", "smh"},
	},
	{
		item: GIFItem{
			ID:         "fb-5",
			Title:      "Clapping Leonardo",
			URL:        "https://media.tenor.com/1B-C3a4G5gEAAAAC/applause-clapping.gif",
			PreviewURL: "https://media.tenor.com/1B-C3a4G5gEAAAAM/applause-clapping.gif",
			Width:      498,
			Height:     280,
		},
		tags: []string{"applause", "clapping", "bravo", "good job", "congrats"},
	},
	{
		item: GIFItem{
			ID:         "fb-6",
			Title:      "Crying Cat",
			URL:        "https://media.tenor.com/O6S4Fw28bZcAAAAC/sad-crying.gif",
			PreviewURL: "https://media.tenor.com/O6S4Fw28bZcAAAAM/sad-crying.gif",
			Width:      498,
			Height:     498,
		},
		tags: []string{"sad", "crying", "tears", "cat", "no"},
	},
	{
		item: GIFItem{
			ID:         "fb-7",
			Title:      "Thumbs Up Chuck Norris",
			URL:        "https://media.tenor.com/93Kq_d6k5HkAAAAC/thumbs-up-good.gif",
			PreviewURL: "https://media.tenor.com/93Kq_d6k5HkAAAAM/thumbs-up-good.gif",
			Width:      498,
			Height:     370,
		},
		tags: []string{"thumbs up", "good", "nice", "ok", "agree"},
	},
	{
		item: GIFItem{
			ID:         "fb-8",
			Title:      "Party Hard Confetti",
			URL:        "https://media.tenor.com/PZcI9f2c3XIAAAAC/party-confetti.gif",
			PreviewURL: "https://media.tenor.com/PZcI9f2c3XIAAAAM/party-confetti.gif",
			Width:      498,
			Height:     280,
		},
		tags: []string{"party", "confetti", "celebration", "happy", "disco"},
	},
	{
		item: GIFItem{
			ID:         "fb-9",
			Title:      "Cute Cat Vibing",
			URL:        "https://media.tenor.com/N18x2fR3yHwAAAAC/cat-cute.gif",
			PreviewURL: "https://media.tenor.com/N18x2fR3yHwAAAAM/cat-cute.gif",
			Width:      498,
			Height:     498,
		},
		tags: []string{"cat", "cute", "vibe", "kitten", "pet"},
	},
	{
		item: GIFItem{
			ID:         "fb-10",
			Title:      "Surprised Pikachu",
			URL:        "https://media.tenor.com/Qh1P-k4V404AAAAC/shocked-surprised.gif",
			PreviewURL: "https://media.tenor.com/Qh1P-k4V404AAAAM/shocked-surprised.gif",
			Width:      498,
			Height:     374,
		},
		tags: []string{"shocked", "surprised", "pikachu", "wow", "omg"},
	},
	{
		item: GIFItem{
			ID:         "fb-11",
			Title:      "Dog Head Tilt",
			URL:        "https://media.tenor.com/Uo2xI28fQjAAAAAC/dog-confused.gif",
			PreviewURL: "https://media.tenor.com/Uo2xI28fQjAAAAAM/dog-confused.gif",
			Width:      498,
			Height:     374,
		},
		tags: []string{"dog", "confused", "cute", "puppy", "what"},
	},
	{
		item: GIFItem{
			ID:         "fb-12",
			Title:      "Popcorn Eating",
			URL:        "https://media.tenor.com/pM2viP0tRhAAAAAC/popcorn-eating.gif",
			PreviewURL: "https://media.tenor.com/pM2viP0tRhAAAAAM/popcorn-eating.gif",
			Width:      498,
			Height:     280,
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
