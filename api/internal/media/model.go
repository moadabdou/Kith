package media

import (
	"time"
)

const (
	StatusPending = "pending"
	StatusReady   = "ready"
	StatusFailed  = "failed"
)

// Attachment represents a media file uploaded to a channel.
type Attachment struct {
	ID              string         `json:"id"`
	ChannelID       string         `json:"channel_id"`
	UploaderID      string         `json:"uploader_id"`
	MessageID       *string        `json:"message_id,omitempty"`
	Filename        string         `json:"filename"`
	ContentType     string         `json:"content_type"`
	ByteSize        int64          `json:"size"`
	SHA256          string         `json:"sha256"`
	S3Bucket        string         `json:"-"`
	S3Key           string         `json:"-"`
	URL             string         `json:"url"`
	ProxyURL        string         `json:"proxy_url,omitempty"`
	Status          string         `json:"status"`
	Width           *int           `json:"width,omitempty"`
	Height          *int           `json:"height,omitempty"`
	DurationSeconds *float64       `json:"duration_secs,omitempty"`
	Thumbnails      map[string]any `json:"thumbnails,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
}

// PresignedUploadResponse is returned to clients requesting a direct-to-S3 upload.
type PresignedUploadResponse struct {
	ID        string    `json:"id"`
	UploadURL string    `json:"upload_url"`
	S3Key     string    `json:"s3_key"`
	ExpiresAt time.Time `json:"expires_at"`
}

// PresignRequest defines client parameters for presigned upload creation.
type PresignRequest struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	ByteSize    int64  `json:"byte_size"`
}
