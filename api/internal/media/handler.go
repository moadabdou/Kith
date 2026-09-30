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

// ServeAttachment handles edge delivery of media attachments with signature verification and byte-range support:
// GET /attachments/{cid}/{aid}/{filename}
// GET /api/media/attachments/{cid}/{aid}/{filename}
func (h *Handler) ServeAttachment(w http.ResponseWriter, r *http.Request) {
	channelID, err := parseChannelID(r)
	if err != nil {
		errs.Write(w, errs.UnknownChannel())
		return
	}

	aidStr := r.PathValue("aid")
	if aidStr == "" {
		aidStr = r.PathValue("id")
	}
	filename := r.PathValue("filename")

	// 1. Signature Verification
	signer := h.Svc.Signer()
	hasSig := r.URL.Query().Get("hm") != ""

	if hasSig && signer != nil {
		if err := signer.VerifyURL(r.URL); err != nil {
			errs.Write(w, &errs.Error{
				Status:  http.StatusForbidden,
				Code:    40003,
				Message: fmt.Sprintf("Invalid or expired media signature: %v", err),
			})
			return
		}
	} else {
		// If unsigned, check if channel requires signed URLs
		isPrivate, err := h.Svc.IsChannelPrivate(r.Context(), channelID)
		if err == nil && isPrivate {
			errs.Write(w, &errs.Error{
				Status:  http.StatusForbidden,
				Code:    40003,
				Message: "Access denied: signed URL required for private channel media",
			})
			return
		}
	}

	// 2. Resolve S3 key: attachments/{channel_id}/{attachment_id}/{filename}
	s3Key := fmt.Sprintf("attachments/%d/%s/%s", channelID, aidStr, filename)

	obj, info, err := h.Svc.Storage().GetSeekableObject(r.Context(), h.Svc.Bucket(), s3Key)
	if err != nil {
		errs.Write(w, &errs.Error{
			Status:  http.StatusNotFound,
			Code:    10008,
			Message: "Unknown Attachment",
		})
		return
	}
	defer obj.Close()

	// 3. Set caching headers for content-addressed immutable media
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Accept-Ranges", "bytes")
	if info.ContentType != "" {
		w.Header().Set("Content-Type", info.ContentType)
	}

	// 4. Stream content using http.ServeContent (natively handles Range: bytes=X-Y -> HTTP 206)
	http.ServeContent(w, r, filename, info.LastModified, obj)
}
