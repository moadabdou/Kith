// Package errs is the shared error-code registry and envelope (plan/02 §6).
//
// REST and the gateway (Phase 1) share these codes. The wire shape is
// exactly Discord's:
//
//	{"code": 50001, "message": "Missing Access"}
//
// and for validation failures, with per-field detail:
//
//	{"code": 50035, "message": "Invalid Form Body",
//	 "errors": {"username": {"_errors": [{"code": "...", "message": "..."}]}}}
//
// Auth failures use plain 401 semantics (code 0), like Discord.
package errs

import (
	"encoding/json"
	"net/http"
)

// Discord error codes used by this API. Registry: discord.com/developers/
// docs/topics/opcodes-and-status-codes. Keep numeric values identical —
// the gateway will reuse them (00-architecture: REST and gateway share codes).
const (
	CodeUnknownAccount  = 10001
	CodeUnknownChannel  = 10003
	CodeUnknownGuild    = 10004
	CodeUnknownInvite   = 10006
	CodeUnknownMember   = 10007
	CodeUnknownMessage  = 10008
	CodeUnknownUser     = 10013
	CodeCannotEditOther = 50005 // Cannot edit a message authored by another user
	CodeMissingAccess   = 50001
	CodeMissingPerms    = 50013
	CodeInvalidFormBody = 50035
	CodeRateLimited     = 29001
)

// Error is an API error: Discord code + HTTP status + message, with
// optional per-field validation detail (50035).
type Error struct {
	Status  int
	Code    int
	Message string

	// Fields maps a JSON field name to its validation failures. Only set
	// by InvalidFormBody. Wire-nested as Discord does: field → _errors.
	Fields map[string][]Detail
}

// Detail is one validation failure for one field.
type Detail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

// envelope is the wire shape (lowercase keys omitted when empty).
type envelope struct {
	Code    int                    `json:"code"`
	Message string                 `json:"message"`
	Errors  map[string]fieldErrors `json:"errors,omitempty"`
}

type fieldErrors struct {
	Errors []Detail `json:"_errors"`
}

// Write renders e as the Discord error envelope with its HTTP status.
func Write(w http.ResponseWriter, e *Error) {
	env := envelope{Code: e.Code, Message: e.Message}
	if len(e.Fields) > 0 {
		env.Errors = make(map[string]fieldErrors, len(e.Fields))
		for field, details := range e.Fields {
			env.Errors[field] = fieldErrors{Errors: details}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	json.NewEncoder(w).Encode(env)
}

// ── constructors ──────────────────────────────────────────────────────────

func UnknownChannel() *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeUnknownChannel, Message: "Unknown Channel"}
}
func UnknownGuild() *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeUnknownGuild, Message: "Unknown Guild"}
}
func UnknownInvite() *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeUnknownInvite, Message: "Unknown Invite"}
}
func UnknownMember() *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeUnknownMember, Message: "Unknown Member"}
}
func UnknownMessage() *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeUnknownMessage, Message: "Unknown Message"}
}
func UnknownUser() *Error {
	return &Error{Status: http.StatusNotFound, Code: CodeUnknownUser, Message: "Unknown User"}
}
func MissingAccess() *Error {
	return &Error{Status: http.StatusForbidden, Code: CodeMissingAccess, Message: "Missing Access"}
}
func MissingPermissions() *Error {
	return &Error{Status: http.StatusForbidden, Code: CodeMissingPerms, Message: "Missing Permissions"}
}
func CannotEditOther() *Error {
	return &Error{Status: http.StatusForbidden, Code: CodeCannotEditOther, Message: "Cannot edit a message authored by another user"}
}
func Unauthorized() *Error {
	return &Error{Status: http.StatusUnauthorized, Code: 0, Message: "401: Unauthorized"}
}

// Internal is the 500 that never leaks internals.
func Internal() *Error {
	return &Error{Status: http.StatusInternalServerError, Code: 0, Message: "Internal Server Error"}
}

// InvalidFormBody builds a 50035 with per-field detail.
func InvalidFormBody(fields map[string][]Detail) *Error {
	return &Error{
		Status:  http.StatusBadRequest,
		Code:    CodeInvalidFormBody,
		Message: "Invalid Form Body",
		Fields:  fields,
	}
}
