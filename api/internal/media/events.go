package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

const (
	MediaStreamName    = "KITH_MEDIA"
	MediaStreamSubject = "kith.media.>"
	UploadSubject      = "kith.media.upload"
	EventTypeUpload    = "FILE_UPLOAD"
	EventVersion       = 1
)

// FileUploadPayload is dispatched to the media worker queue when an attachment upload completes.
type FileUploadPayload struct {
	AttachmentID string `json:"attachment_id"`
	MessageID    string `json:"message_id,omitempty"`
	ChannelID    string `json:"channel_id"`
	GuildID      string `json:"guild_id,omitempty"`
	UploaderID   string `json:"uploader_id"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type"`
	ByteSize     int64  `json:"byte_size"`
	SHA256       string `json:"sha256"`
	S3Bucket     string `json:"s3_bucket"`
	S3Key        string `json:"s3_key"`
}

// MediaEvent wraps a media event envelope.
type MediaEvent struct {
	Type    string            `json:"type"`
	Version int               `json:"version"`
	Payload FileUploadPayload `json:"payload"`
}

// EventPublisher defines the media pipeline event publisher seam.
type EventPublisher interface {
	PublishUpload(ctx context.Context, payload FileUploadPayload) error
}

// NatsEventPublisher publishes media events to NATS JetStream.
type NatsEventPublisher struct {
	js nats.JetStreamContext
}

// NewNatsEventPublisher initializes or updates the KITH_MEDIA stream and returns the publisher.
func NewNatsEventPublisher(js nats.JetStreamContext) (*NatsEventPublisher, error) {
	if js == nil {
		return nil, errors.New("media: jetstream context is nil")
	}

	streamCfg := &nats.StreamConfig{
		Name:       MediaStreamName,
		Subjects:   []string{MediaStreamSubject},
		Storage:    nats.FileStorage,
		Retention:  nats.LimitsPolicy,
		Discard:    nats.DiscardOld,
		MaxAge:     7 * 24 * time.Hour,
		Duplicates: 2 * time.Minute,
	}

	if _, err := js.AddStream(streamCfg); err != nil {
		if errors.Is(err, nats.ErrStreamNameAlreadyInUse) {
			if _, err := js.UpdateStream(streamCfg); err != nil {
				return nil, fmt.Errorf("media: update jetstream stream %s: %w", MediaStreamName, err)
			}
		} else {
			return nil, fmt.Errorf("media: create jetstream stream %s: %w", MediaStreamName, err)
		}
	}

	return &NatsEventPublisher{js: js}, nil
}

// PublishUpload publishes a FILE_UPLOAD event to JetStream on subject kith.media.upload.
func (p *NatsEventPublisher) PublishUpload(ctx context.Context, payload FileUploadPayload) error {
	evt := MediaEvent{
		Type:    EventTypeUpload,
		Version: EventVersion,
		Payload: payload,
	}

	data, err := json.Marshal(evt)
	if err != nil {
		return fmt.Errorf("media: marshal event: %w", err)
	}

	// Message ID for deduplication in JetStream
	msgID := fmt.Sprintf("upload-%s", payload.AttachmentID)
	msg := &nats.Msg{
		Subject: UploadSubject,
		Data:    data,
		Header:  nats.Header{"Nats-Msg-Id": []string{msgID}},
	}

	_, err = p.js.PublishMsg(msg, nats.Context(ctx))
	if err != nil {
		return fmt.Errorf("media: publish upload event: %w", err)
	}

	slog.InfoContext(ctx, "media upload event published",
		"subject", UploadSubject,
		"attachment_id", payload.AttachmentID,
		"sha256", payload.SHA256,
	)
	return nil
}

// NoopEventPublisher drops events (useful for tests or disabled NATS).
type NoopEventPublisher struct{}

func (NoopEventPublisher) PublishUpload(_ context.Context, p FileUploadPayload) error {
	slog.Debug("media upload event published (noop)", "attachment_id", p.AttachmentID)
	return nil
}
