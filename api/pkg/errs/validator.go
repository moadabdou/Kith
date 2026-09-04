package errs

// Validator collects per-field validation failures and renders them as a
// 50035 Invalid Form Body error (centralized validation, plan/02 §6).
//
//	v := errs.NewValidator()
//	v.Check("username", len(username) >= 3, "BASE_TYPE_BAD_LENGTH",
//	        "Must be between 3 and 32 in length.")
//	if v.Err() != nil { ... errs.Write(w, v.Err()) ... }
type Validator struct {
	fields map[string][]Detail
}

// NewValidator returns an empty validator.
func NewValidator() *Validator {
	return &Validator{fields: map[string][]Detail{}}
}

// Check records a failure for field when ok is false. code is a
// Discord-style validation code (e.g. BASE_TYPE_BAD_LENGTH); multiple
// failures per field are kept in order.
func (v *Validator) Check(field string, ok bool, code, message string) {
	if ok {
		return
	}
	v.fields[field] = append(v.fields[field], Detail{Code: code, Message: message})
}

// Err returns the InvalidFormBody error, or nil when every check passed.
func (v *Validator) Err() *Error {
	if len(v.fields) == 0 {
		return nil
	}
	return InvalidFormBody(v.fields)
}

// Common validation codes (Discord's naming).
const (
	CodeRequired         = "BASE_TYPE_REQUIRED"
	CodeBadLength        = "BASE_TYPE_BAD_LENGTH"
	CodeInvalidType      = "BASE_TYPE_INVALID_TYPE"
	CodeEmailInvalid     = "EMAIL_TYPE_INVALID"
	CodePasswordTooShort = "PASSWORD_TYPE_TOO_SHORT"
)
