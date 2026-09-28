package media

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
)

// Handler handles HTTP requests for media attachments.
type Handler struct {
	Svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{Svc: svc}
}

// Upload handles direct multipart form uploads:
// POST /api/channels/{cid}/attachments
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	channelID, err := parseChannelID(r)
	if err != nil {
		errs.Write(w, errs.UnknownChannel())
		return
	}

	userID, ok := auth.UserIDFrom(r.Context())
	if !ok || userID == 0 {
		errs.Write(w, errs.Unauthorized())
		return
	}

	// Restrict request body to maxUploadSize + 32KB buffer for headers
	r.Body = http.MaxBytesReader(w, r.Body, h.Svc.maxUploadSize+32*1024)

	reader, err := r.MultipartReader()
	if err != nil {
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "Invalid multipart form data",
		})
		return
	}

	for {
		part, err := reader.NextPart()
		if err != nil {
			errs.Write(w, &errs.Error{
				Status:  http.StatusBadRequest,
				Code:    errs.CodeInvalidFormBody,
				Message: "Missing 'file' field in multipart body",
			})
			return
		}

		if part.FormName() == "file" {
			declaredFilename := part.FileName()
			if declaredFilename == "" {
				declaredFilename = "attachment"
			}

			att, err := h.Svc.UploadAttachment(r.Context(), userID, channelID, declaredFilename, part, -1)
			if err != nil {
				h.writeError(w, err)
				return
			}

			httpx.JSON(w, http.StatusCreated, att)
			return
		}
	}
}

// Presign issues a presigned S3 PUT URL for direct client-to-storage upload:
// POST /api/channels/{cid}/attachments/presign
func (h *Handler) Presign(w http.ResponseWriter, r *http.Request) {
	channelID, err := parseChannelID(r)
	if err != nil {
		errs.Write(w, errs.UnknownChannel())
		return
	}

	userID, ok := auth.UserIDFrom(r.Context())
	if !ok || userID == 0 {
		errs.Write(w, errs.Unauthorized())
		return
	}

	var req PresignRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "Malformed JSON payload",
		})
		return
	}

	resp, err := h.Svc.CreatePresignedUpload(r.Context(), userID, channelID, req)
	if err != nil {
		h.writeError(w, err)
		return
	}

	httpx.JSON(w, http.StatusCreated, resp)
}

// Complete finalizes a presigned upload once the client has PUT the object to S3:
// POST /api/channels/{cid}/attachments/{id}/complete
func (h *Handler) Complete(w http.ResponseWriter, r *http.Request) {
	channelID, err := parseChannelID(r)
	if err != nil {
		errs.Write(w, errs.UnknownChannel())
		return
	}

	attachmentID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || attachmentID <= 0 {
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "Invalid attachment id",
		})
		return
	}

	userID, ok := auth.UserIDFrom(r.Context())
	if !ok || userID == 0 {
		errs.Write(w, errs.Unauthorized())
		return
	}

	att, err := h.Svc.CompletePresignedUpload(r.Context(), userID, channelID, attachmentID)
	if err != nil {
		h.writeError(w, err)
		return
	}

	httpx.JSON(w, http.StatusOK, att)
}

// Get fetches attachment metadata:
// GET /api/channels/{cid}/attachments/{id}
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	attachmentID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || attachmentID <= 0 {
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "Invalid attachment id",
		})
		return
	}

	att, err := h.Svc.GetAttachment(r.Context(), attachmentID)
	if err != nil {
		h.writeError(w, err)
		return
	}

	httpx.JSON(w, http.StatusOK, att)
}

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrDangerousFile):
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "Executable or dangerous file type rejected",
		})
	case errors.Is(err, ErrFileTooLarge):
		errs.Write(w, &errs.Error{
			Status:  http.StatusRequestEntityTooLarge,
			Code:    40005,
			Message: fmt.Sprintf("File exceeds maximum allowed size of %d bytes", h.Svc.maxUploadSize),
		})
	case errors.Is(err, ErrEmptyFile):
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "File payload is empty",
		})
	case errors.Is(err, ErrMissingAccess):
		errs.Write(w, errs.MissingAccess())
	case errors.Is(err, ErrMissingPermissions):
		errs.Write(w, errs.MissingPermissions())
	case errors.Is(err, ErrUnauthorized):
		errs.Write(w, errs.Unauthorized())
	case errors.Is(err, ErrAttachmentNotFound):
		errs.Write(w, &errs.Error{
			Status:  http.StatusNotFound,
			Code:    10008,
			Message: "Unknown Attachment",
		})
	default:
		errs.Write(w, errs.Internal())
	}
}

func parseChannelID(r *http.Request) (int64, error) {
	cidStr := r.PathValue("cid")
	if cidStr == "" {
		cidStr = r.PathValue("id")
	}
	id, err := strconv.ParseInt(cidStr, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid channel id: %s", cidStr)
	}
	return id, nil
}
