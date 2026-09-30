package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

type memoryStorage struct {
	mu      sync.RWMutex
	objects map[string][]byte
}

func newMemoryStorage() *memoryStorage {
	return &memoryStorage{
		objects: make(map[string][]byte),
	}
}

func (m *memoryStorage) PutObject(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	m.objects[bucket+"/"+key] = data
	return nil
}

func (m *memoryStorage) GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.objects[bucket+"/"+key]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

type memoryReadSeekCloser struct {
	*bytes.Reader
}

func (m *memoryReadSeekCloser) Close() error {
	return nil
}

func (m *memoryStorage) GetSeekableObject(ctx context.Context, bucket, key string) (io.ReadSeekCloser, minio.ObjectInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.objects[bucket+"/"+key]
	if !ok {
		return nil, minio.ObjectInfo{}, fmt.Errorf("not found")
	}
	info := minio.ObjectInfo{
		Size: int64(len(data)),
		Key:  key,
	}
	return &memoryReadSeekCloser{Reader: bytes.NewReader(data)}, info, nil
}

func (m *memoryStorage) StatObject(ctx context.Context, bucket, key string) (minio.ObjectInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.objects[bucket+"/"+key]
	if !ok {
		return minio.ObjectInfo{}, fmt.Errorf("not found")
	}
	return minio.ObjectInfo{
		Size: int64(len(data)),
		Key:  key,
	}, nil
}

func (m *memoryStorage) RemoveObject(ctx context.Context, bucket, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, bucket+"/"+key)
	return nil
}

func (m *memoryStorage) CopyObject(ctx context.Context, dstBucket, dstKey, srcBucket, srcKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objects[srcBucket+"/"+srcKey]
	if !ok {
		return fmt.Errorf("source object not found")
	}
	m.objects[dstBucket+"/"+dstKey] = data
	return nil
}

func (m *memoryStorage) PresignedPutURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
	return fmt.Sprintf("https://s3.example.com/%s/%s?presigned=true", bucket, key), nil
}

func (m *memoryStorage) PresignedGetURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
	return fmt.Sprintf("https://s3.example.com/%s/%s", bucket, key), nil
}

func (m *memoryStorage) PublicURL(bucket, key string) string {
	return fmt.Sprintf("https://cdn.example.com/%s/%s", bucket, key)
}

type memoryStore struct {
	mu          sync.RWMutex
	attachments map[string]*Attachment
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		attachments: make(map[string]*Attachment),
	}
}

func (s *memoryStore) CreateAttachment(ctx context.Context, att *Attachment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attachments[att.ID] = att
	return nil
}

func (s *memoryStore) GetAttachment(ctx context.Context, id int64) (*Attachment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	idStr := fmt.Sprintf("%d", id)
	att, ok := s.attachments[idStr]
	if !ok {
		return nil, ErrAttachmentNotFound
	}
	return att, nil
}

func (s *memoryStore) GetAttachmentsByIDs(ctx context.Context, ids []int64) ([]Attachment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var list []Attachment
	for _, id := range ids {
		if att, ok := s.attachments[fmt.Sprintf("%d", id)]; ok {
			list = append(list, *att)
		}
	}
	return list, nil
}

func (s *memoryStore) GetAttachmentsForMessage(ctx context.Context, messageID int64) ([]Attachment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var list []Attachment
	mStr := fmt.Sprintf("%d", messageID)
	for _, att := range s.attachments {
		if att.MessageID != nil && *att.MessageID == mStr {
			list = append(list, *att)
		}
	}
	return list, nil
}

func (s *memoryStore) GetAttachmentsForMessages(ctx context.Context, messageIDs []int64) (map[string][]Attachment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := make(map[string][]Attachment)
	for _, id := range messageIDs {
		mStr := fmt.Sprintf("%d", id)
		for _, att := range s.attachments {
			if att.MessageID != nil && *att.MessageID == mStr {
				m[mStr] = append(m[mStr], *att)
			}
		}
	}
	return m, nil
}

func (s *memoryStore) LinkAttachmentsToMessage(ctx context.Context, messageID int64, attachmentIDs []int64, channelID, uploaderID int64) ([]Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mStr := fmt.Sprintf("%d", messageID)
	cStr := fmt.Sprintf("%d", channelID)
	uStr := fmt.Sprintf("%d", uploaderID)

	var linked []Attachment
	for _, id := range attachmentIDs {
		att, ok := s.attachments[fmt.Sprintf("%d", id)]
		if !ok || att.ChannelID != cStr || att.UploaderID != uStr || att.MessageID != nil {
			return nil, ErrAttachmentConflict
		}
		att.MessageID = &mStr
		linked = append(linked, *att)
	}
	return linked, nil
}

func (s *memoryStore) UpdateAttachmentStatus(ctx context.Context, id int64, status string, width, height *int, duration *float64, thumbnails map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	att, ok := s.attachments[fmt.Sprintf("%d", id)]
	if !ok {
		return ErrAttachmentNotFound
	}
	att.Status = status
	return nil
}

func (s *memoryStore) UpdateCompletedUpload(ctx context.Context, id int64, s3Key, sha256Hex, contentType string, byteSize int64, filename, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	att, ok := s.attachments[fmt.Sprintf("%d", id)]
	if !ok {
		return ErrAttachmentNotFound
	}
	att.S3Key = s3Key
	att.SHA256 = sha256Hex
	att.ContentType = contentType
	att.ByteSize = byteSize
	att.Filename = filename
	att.Status = status
	return nil
}

type memoryPublisher struct {
	mu     sync.Mutex
	events []FileUploadPayload
}

func (p *memoryPublisher) PublishUpload(ctx context.Context, payload FileUploadPayload) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, payload)
	return nil
}

func setupTestService(t *testing.T) (*Service, *memoryStorage, *memoryStore, *memoryPublisher) {
	sf, err := snowflake.NewNode(1)
	if err != nil {
		t.Fatalf("failed to create snowflake node: %v", err)
	}

	storage := newMemoryStorage()
	store := newMemoryStore()
	pub := &memoryPublisher{}

	svc := NewService(nil, store, storage, sf, pub, "attachments", 10*1024*1024)
	return svc, storage, store, pub
}

func TestDirectUploadSuccess(t *testing.T) {
	svc, storage, store, pub := setupTestService(t)

	// Valid PNG payload
	pngHeader := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89")
	payload := append(pngHeader, bytes.Repeat([]byte{0x42}, 1000)...)
	hasher := sha256.New()
	hasher.Write(payload)
	expectedSHA := hex.EncodeToString(hasher.Sum(nil))

	att, err := svc.UploadAttachment(
		context.Background(),
		1001, 2002,
		"screenshot.png",
		bytes.NewReader(payload),
		int64(len(payload)),
	)
	if err != nil {
		t.Fatalf("unexpected upload error: %v", err)
	}

	if att.SHA256 != expectedSHA {
		t.Errorf("sha mismatch: got %q, want %q", att.SHA256, expectedSHA)
	}
	if att.ContentType != "image/png" {
		t.Errorf("content type mismatch: got %q, want image/png", att.ContentType)
	}
	if att.ByteSize != int64(len(payload)) {
		t.Errorf("size mismatch: got %d, want %d", att.ByteSize, len(payload))
	}
	if att.Status != StatusPending {
		t.Errorf("status mismatch: got %q, want pending", att.Status)
	}

	// Verify MinIO storage has object at content-addressed key
	storedData, ok := storage.objects["attachments/"+att.S3Key]
	if !ok {
		t.Fatalf("object was not saved to storage at key %q", att.S3Key)
	}
	if !bytes.Equal(storedData, payload) {
		t.Errorf("stored bytes do not match uploaded payload")
	}

	// Verify DB store has record
	var found *Attachment
	for _, a := range store.attachments {
		if a.ID == att.ID {
			found = a
			break
		}
	}
	if found == nil {
		t.Fatalf("attachment %s was not found in store", att.ID)
	}

	// Verify JetStream event was published
	if len(pub.events) != 1 {
		t.Fatalf("expected 1 event published, got %d", len(pub.events))
	}
	evt := pub.events[0]
	if evt.AttachmentID != att.ID || evt.SHA256 != expectedSHA {
		t.Errorf("published event mismatch: %+v", evt)
	}
}

func TestDirectUploadRejectExecutable(t *testing.T) {
	svc, _, _, pub := setupTestService(t)

	// Disguised Windows PE executable with .png extension
	exeHeader := []byte("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00")
	payload := append(exeHeader, bytes.Repeat([]byte{0x00}, 500)...)

	_, err := svc.UploadAttachment(
		context.Background(),
		1001, 2002,
		"innocent_photo.png",
		bytes.NewReader(payload),
		int64(len(payload)),
	)
	if err == nil {
		t.Fatalf("expected executable to be rejected, got nil error")
	}
	if err != ErrDangerousFile {
		t.Errorf("expected ErrDangerousFile, got %v", err)
	}

	if len(pub.events) != 0 {
		t.Errorf("expected 0 events published for rejected upload")
	}
}

func TestPresignedUploadLifecycle(t *testing.T) {
	svc, storage, _, pub := setupTestService(t)

	// Step 1: Request presigned upload
	presignResp, err := svc.CreatePresignedUpload(
		context.Background(),
		1001, 2002,
		PresignRequest{
			Filename:    "clip.mp4",
			ContentType: "video/mp4",
			ByteSize:    5000,
		},
	)
	if err != nil {
		t.Fatalf("presign request failed: %v", err)
	}
	if presignResp.UploadURL == "" || presignResp.S3Key == "" {
		t.Fatalf("invalid presign response: %+v", presignResp)
	}

	// Step 2: Client uploads directly to storage at presignResp.S3Key
	pngHeader := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89")
	storage.objects["attachments/"+presignResp.S3Key] = pngHeader

	// Step 3: Finalize and link upload atomically at send time (Discord model)
	var attID int64
	fmt.Sscanf(presignResp.ID, "%d", &attID)

	linked, err := svc.FinalizeAndLink(
		context.Background(),
		9999,
		[]int64{attID},
		2002, 1001,
		3003,
	)
	if err != nil {
		t.Fatalf("finalize and link failed: %v", err)
	}

	if len(linked) != 1 {
		t.Fatalf("expected 1 linked attachment, got %d", len(linked))
	}
	completed := linked[0]
	if completed.Status != StatusPending {
		t.Errorf("expected status pending, got %q", completed.Status)
	}
	if completed.SHA256 == "" {
		t.Errorf("expected sha256 to be computed")
	}
	if completed.MessageID == nil || *completed.MessageID != "9999" {
		t.Errorf("expected message_id 9999, got %v", completed.MessageID)
	}

	// Verify event dispatched with message_id and guild_id stamped
	if len(pub.events) != 1 {
		t.Fatalf("expected 1 event dispatched, got %d", len(pub.events))
	}
	if pub.events[0].MessageID != "9999" {
		t.Errorf("expected event MessageID 9999, got %q", pub.events[0].MessageID)
	}
	if pub.events[0].GuildID != "3003" {
		t.Errorf("expected event GuildID 3003, got %q", pub.events[0].GuildID)
	}

	// Trying to link already-linked attachment should fail
	_, err = svc.FinalizeAndLink(context.Background(), 8888, []int64{attID}, 2002, 1001, 3003)
	if err != ErrAttachmentConflict && err != ErrAttachmentNotFound {
		t.Errorf("expected conflict on double link, got %v", err)
	}
}
