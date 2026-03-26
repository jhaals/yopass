package server

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3FileStore stores encrypted files in an S3-compatible bucket.
type S3FileStore struct {
	client *s3.Client
	bucket string
	prefix string
}

// NewS3FileStore creates an S3FileStore.
// endpoint may be empty for standard AWS S3, or set to a MinIO/compatible URL.
func NewS3FileStore(bucket, prefix, endpoint, region string) (*S3FileStore, error) {
	ctx := context.Background()

	var opts []func(*config.LoadOptions) error
	if region != "" {
		opts = append(opts, config.WithRegion(region))
	}

	cfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("could not load AWS config: %w", err)
	}

	var s3Opts []func(*s3.Options)
	if endpoint != "" {
		s3Opts = append(s3Opts, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(endpoint)
			o.UsePathStyle = true
		})
	}

	client := s3.NewFromConfig(cfg, s3Opts...)
	return &S3FileStore{client: client, bucket: bucket, prefix: prefix}, nil
}

func (s *S3FileStore) objectKey(key string) string {
	return s.prefix + key
}

// Save uploads the data stream to S3. The Expires metadata is set for lifecycle-based cleanup.
func (s *S3FileStore) Save(ctx context.Context, key string, data io.Reader, contentLength int64) error {
	input := &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.objectKey(key)),
		Body:   data,
	}
	if contentLength > 0 {
		input.ContentLength = aws.Int64(contentLength)
	}

	_, err := s.client.PutObject(ctx, input)
	if err != nil {
		return fmt.Errorf("s3 put failed: %w", err)
	}
	return nil
}

// SaveMeta sets expiration metadata on the S3 object via both tagging (for our
// cleanup goroutine) and the Expires header (for optional S3 lifecycle rules).
func (s *S3FileStore) SaveMeta(ctx context.Context, key string, expirationSeconds int32) error {
	expires := time.Now().Add(time.Duration(expirationSeconds) * time.Second)
	objKey := s.objectKey(key)

	// Set tag for our cleanup goroutine
	_, err := s.client.PutObjectTagging(ctx, &s3.PutObjectTaggingInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objKey),
		Tagging: &s3types.Tagging{
			TagSet: []s3types.Tag{{
				Key:   aws.String("yopass-expires"),
				Value: aws.String(fmt.Sprintf("%d", expires.Unix())),
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("s3 put tagging failed: %w", err)
	}

	// Set Expires metadata for optional S3 lifecycle rules
	_, err = s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:            aws.String(s.bucket),
		CopySource:        aws.String(s.bucket + "/" + objKey),
		Key:               aws.String(objKey),
		Expires:           aws.Time(expires),
		MetadataDirective: s3types.MetadataDirectiveReplace,
	})
	if err != nil {
		return fmt.Errorf("s3 copy (set expires) failed: %w", err)
	}
	return nil
}

// Load retrieves the object from S3.
func (s *S3FileStore) Load(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	output, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.objectKey(key)),
	})
	if err != nil {
		return nil, 0, fmt.Errorf("s3 get failed: %w", err)
	}

	var size int64
	if output.ContentLength != nil {
		size = *output.ContentLength
	}
	return output.Body, size, nil
}

// Delete removes the object from S3.
func (s *S3FileStore) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.objectKey(key)),
	})
	if err != nil {
		return fmt.Errorf("s3 delete failed: %w", err)
	}
	return nil
}

// Health checks S3 connectivity via HeadBucket.
func (s *S3FileStore) Health(ctx context.Context) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: aws.String(s.bucket),
	})
	if err != nil {
		return fmt.Errorf("s3 health check failed: %w", err)
	}
	return nil
}
