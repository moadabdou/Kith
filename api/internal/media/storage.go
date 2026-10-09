package media

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Storage abstracts object storage operations (MinIO / S3).
type Storage interface {
	PutObject(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) error
	GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, error)
	GetSeekableObject(ctx context.Context, bucket, key string) (io.ReadSeekCloser, minio.ObjectInfo, error)
	StatObject(ctx context.Context, bucket, key string) (minio.ObjectInfo, error)
	RemoveObject(ctx context.Context, bucket, key string) error
	CopyObject(ctx context.Context, dstBucket, dstKey, srcBucket, srcKey string) error
	PresignedPutURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error)
	PresignedGetURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error)
	PublicURL(bucket, key string) string
}

// StorageConfig holds parameters for connecting to S3 / MinIO.
type StorageConfig struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	UseSSL    bool
	PublicURL string
	// PublicEndpoint is the browser-reachable host:port of the object
	// store (e.g. "localhost:9000"). Browsers cannot resolve the
	// container-network Endpoint ("minio:9000"), and SigV4 signs the
	// Host header, so presigned URLs minted for the internal endpoint
	// would be both unreachable and invalid. When set, presigned URLs
	// are minted through a client bound to PublicEndpoint (same creds,
	// same region, same path style — only the host differs), while all
	// server-side operations keep using the internal client.
	PublicEndpoint string
}

// MinIOStorage implements Storage using the official MinIO Go SDK.
type MinIOStorage struct {
	client       *minio.Client
	publicClient *minio.Client
	publicURL    string
}

// minioRegion pins the signature region so the SDK never performs a
// bucket-location lookup. The lookup dials the endpoint host, which is
// wrong for the public client (from inside the API container "localhost"
// is itself, not MinIO) and wasteful for the internal one. MinIO's
// default region is us-east-1.
const minioRegion = "us-east-1"

// NewMinIOStorage initializes a MinIO client connection.
func NewMinIOStorage(cfg StorageConfig) (*MinIOStorage, error) {
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
		Region: minioRegion,
	})
	if err != nil {
		return nil, fmt.Errorf("minio: failed to initialize client: %w", err)
	}

	var publicClient *minio.Client
	if pub := normalizeEndpoint(cfg.PublicEndpoint); pub != "" && pub != cfg.Endpoint {
		publicSecure := cfg.UseSSL
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(cfg.PublicURL)), "https://") ||
			strings.HasPrefix(strings.ToLower(strings.TrimSpace(cfg.PublicEndpoint)), "https://") {
			publicSecure = true
		}

		publicClient, err = minio.New(pub, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
			Secure: publicSecure,
			Region: minioRegion,
		})
		if err != nil {
			return nil, fmt.Errorf("minio: failed to initialize public client: %w", err)
		}
	}

	pubURL := cfg.PublicURL
	if pubURL == "" {
		scheme := "http"
		if cfg.UseSSL {
			scheme = "https"
		}
		pubURL = fmt.Sprintf("%s://%s", scheme, cfg.Endpoint)
	}

	return &MinIOStorage{
		client:       client,
		publicClient: publicClient,
		publicURL:    pubURL,
	}, nil
}

// normalizeEndpoint strips an optional URL scheme so both "localhost:9000"
// and "http://localhost:9000" configure the same endpoint.
func normalizeEndpoint(ep string) string {
	ep = strings.TrimSpace(ep)
	ep = strings.TrimPrefix(ep, "https://")
	ep = strings.TrimPrefix(ep, "http://")
	return strings.TrimSuffix(ep, "/")
}

func (s *MinIOStorage) PutObject(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) error {
	opts := minio.PutObjectOptions{
		ContentType: contentType,
	}
	_, err := s.client.PutObject(ctx, bucket, key, reader, size, opts)
	if err != nil {
		return fmt.Errorf("minio: put object failed: %w", err)
	}
	return nil
}

func (s *MinIOStorage) GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("minio: get object failed: %w", err)
	}
	return obj, nil
}

func (s *MinIOStorage) GetSeekableObject(ctx context.Context, bucket, key string) (io.ReadSeekCloser, minio.ObjectInfo, error) {
	obj, err := s.client.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, minio.ObjectInfo{}, fmt.Errorf("minio: get seekable object failed: %w", err)
	}
	info, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		return nil, minio.ObjectInfo{}, fmt.Errorf("minio: stat seekable object failed: %w", err)
	}
	return obj, info, nil
}

func (s *MinIOStorage) StatObject(ctx context.Context, bucket, key string) (minio.ObjectInfo, error) {
	info, err := s.client.StatObject(ctx, bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return minio.ObjectInfo{}, fmt.Errorf("minio: stat object failed: %w", err)
	}
	return info, nil
}

func (s *MinIOStorage) RemoveObject(ctx context.Context, bucket, key string) error {
	err := s.client.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("minio: remove object failed: %w", err)
	}
	return nil
}

func (s *MinIOStorage) CopyObject(ctx context.Context, dstBucket, dstKey, srcBucket, srcKey string) error {
	src := minio.CopySrcOptions{
		Bucket: srcBucket,
		Object: srcKey,
	}
	dst := minio.CopyDestOptions{
		Bucket: dstBucket,
		Object: dstKey,
	}
	_, err := s.client.CopyObject(ctx, dst, src)
	if err != nil {
		return fmt.Errorf("minio: copy object failed: %w", err)
	}
	return nil
}

func (s *MinIOStorage) PresignedPutURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
	// Browser uploads must target the public endpoint (see PublicEndpoint):
	// the signature covers the Host header, so minting must happen on the
	// exact host the browser will PUT to.
	client := s.client
	if s.publicClient != nil {
		client = s.publicClient
	}
	u, err := client.PresignedPutObject(ctx, bucket, key, expiry)
	if err != nil {
		return "", fmt.Errorf("minio: presigned put failed: %w", err)
	}
	return u.String(), nil
}

func (s *MinIOStorage) PresignedGetURL(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
	reqParams := make(url.Values)
	u, err := s.client.PresignedGetObject(ctx, bucket, key, expiry, reqParams)
	if err != nil {
		return "", fmt.Errorf("minio: presigned get failed: %w", err)
	}
	return u.String(), nil
}

func (s *MinIOStorage) PublicURL(bucket, key string) string {
	key = strings.TrimPrefix(key, "/")
	if bucket == "" {
		return fmt.Sprintf("%s/%s", s.publicURL, key)
	}
	return fmt.Sprintf("%s/%s/%s", s.publicURL, bucket, key)
}
