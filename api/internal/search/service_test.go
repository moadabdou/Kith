package search

import (
	"context"
	"testing"
)

func TestSearchParamsValidation(t *testing.T) {
	svc := NewService(nil)

	// Empty query returns ErrQueryRequired
	_, err := svc.SearchGuildMessages(context.Background(), 1, 1, SearchParams{Query: ""})
	if err != ErrQueryRequired {
		t.Fatalf("expected ErrQueryRequired, got %v", err)
	}

	_, err = svc.SearchGuildMessages(context.Background(), 1, 1, SearchParams{Query: "   "})
	if err != ErrQueryRequired {
		t.Fatalf("expected ErrQueryRequired for whitespace query, got %v", err)
	}
}
