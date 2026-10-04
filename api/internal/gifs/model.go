package gifs

// GIFItem is a normalized GIF media item returned to clients.
type GIFItem struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	PreviewURL string `json:"preview_url"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

// GIFResponse contains a list of GIFs and pagination metadata.
type GIFResponse struct {
	Results []GIFItem `json:"results"`
	Page    int       `json:"page"`
	HasNext bool      `json:"has_next"`
	Next    string    `json:"next,omitempty"`
}

// GIFCategory represents a quick search suggestion chip or category.
type GIFCategory struct {
	Name       string `json:"name"`
	SearchTerm string `json:"search_term"`
	PreviewURL string `json:"preview_url"`
}
