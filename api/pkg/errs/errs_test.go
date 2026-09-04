package errs

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEnvelopeShape(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, MissingAccess())

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
	var env struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body not JSON: %v (%s)", err, rec.Body.String())
	}
	if env.Code != 50001 || env.Message != "Missing Access" {
		t.Errorf("envelope = %+v, want {50001 Missing Access}", env)
	}
	// No stray keys: exactly code + message on non-validation errors.
	var raw map[string]json.RawMessage
	json.Unmarshal(rec.Body.Bytes(), &raw)
	if len(raw) != 2 {
		t.Errorf("envelope has %d keys, want exactly 2 (code, message): %s", len(raw), rec.Body.String())
	}
}

func TestInvalidFormBodyFieldDetails(t *testing.T) {
	e := InvalidFormBody(map[string][]Detail{
		"username": {{Code: CodeBadLength, Message: "Must be between 3 and 32 in length."}},
	})
	rec := httptest.NewRecorder()
	Write(rec, e)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	var env struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Errors  map[string]struct {
			Errors []Detail `json:"_errors"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if env.Code != 50035 || env.Message != "Invalid Form Body" {
		t.Errorf("envelope = %d %q", env.Code, env.Message)
	}
	details, ok := env.Errors["username"]
	if !ok || len(details.Errors) != 1 || details.Errors[0].Code != CodeBadLength {
		t.Errorf("username details = %+v", env.Errors)
	}
}

func TestValidator(t *testing.T) {
	v := NewValidator()
	v.Check("username", false, CodeBadLength, "Must be between 3 and 32 in length.")
	v.Check("username", false, CodeInvalidType, "Must be lowercase.")
	v.Check("email", true, CodeEmailInvalid, "unreachable")
	v.Check("password", false, CodePasswordTooShort, "Must be at least 8 characters.")

	e := v.Err()
	if e == nil {
		t.Fatal("Err() = nil, want an error")
	}
	if e.Code != 50035 || e.Status != http.StatusBadRequest {
		t.Errorf("err = %d/%d, want 50035/400", e.Code, e.Status)
	}
	if len(e.Fields["username"]) != 2 {
		t.Errorf("username has %d details, want 2 (order kept)", len(e.Fields["username"]))
	}
	if _, has := e.Fields["email"]; has {
		t.Error("passing check must not be recorded")
	}
	if _, has := e.Fields["password"]; !has {
		t.Error("password failure missing")
	}

	if NewValidator().Err() != nil {
		t.Error("empty validator must return nil")
	}
}

func TestUnauthorizedPlain401(t *testing.T) {
	e := Unauthorized()
	if e.Status != http.StatusUnauthorized || e.Code != 0 {
		t.Errorf("Unauthorized = %d/%d, want 401/0", e.Status, e.Code)
	}
}

func TestErrorImplementsError(t *testing.T) {
	var err error = MissingAccess()
	if err.Error() != "Missing Access" {
		t.Errorf("Error() = %q", err.Error())
	}
}

func TestFormBody(t *testing.T) {
	e := FormBody("Invalid Form Body: bad guild id")
	if e.Status != http.StatusBadRequest || e.Code != 50035 || e.Message == "" {
		t.Errorf("FormBody = %+v", e)
	}
	if e.Fields != nil {
		t.Error("FormBody must not carry field detail")
	}
}

func TestInvalidJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, InvalidJSON())
	var env struct {
		Code   int `json:"code"`
		Errors map[string]struct {
			Errors []Detail `json:"_errors"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if env.Code != 50035 {
		t.Errorf("code = %d, want 50035", env.Code)
	}
	bd, ok := env.Errors["_body"]
	if !ok || len(bd.Errors) != 1 || bd.Errors[0].Code != CodeInvalidType {
		t.Errorf("_body detail = %+v", env.Errors)
	}
}

func TestRateLimited(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, RateLimited(4.2, false))

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", rec.Code)
	}
	var env struct {
		Code       int     `json:"code"`
		Message    string  `json:"message"`
		RetryAfter float64 `json:"retry_after"`
		Global     bool    `json:"global"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if env.Code != 29001 || env.Message != "You are being rate limited." {
		t.Errorf("envelope = %+v", env)
	}
	if env.RetryAfter != 4.2 {
		t.Errorf("retry_after = %f, want 4.2", env.RetryAfter)
	}
	if env.Global {
		t.Error("global must render false (per-route bucket), not be omitted")
	}

	// Non-429 errors must not carry retry_after/global.
	rec = httptest.NewRecorder()
	Write(rec, MissingAccess())
	if rec.Body.String() == "" || strings.Contains(rec.Body.String(), "retry_after") ||
		strings.Contains(rec.Body.String(), "global") {
		t.Errorf("plain error leaked rate-limit keys: %s", rec.Body.String())
	}
}
