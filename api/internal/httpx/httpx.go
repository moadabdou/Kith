// Package httpx holds shared HTTP response helpers.
package httpx

import (
	"encoding/json"
	"net/http"
)

// JSON writes v as a JSON response with the given status code.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// Error writes a Discord-shaped error envelope: {"code": ..., "message": ...}.
// The code registry is formalized in pkg/errs (#8).
func Error(w http.ResponseWriter, status int, code int, message string) {
	JSON(w, status, map[string]any{"code": code, "message": message})
}
