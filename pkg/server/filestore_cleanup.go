package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.uber.org/zap"
)

// StartDiskCleanup runs a background goroutine that periodically removes expired
// files from the disk file store by reading sidecar .meta files.
func StartDiskCleanup(ctx context.Context, store *DiskFileStore, interval time.Duration, logger *zap.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanupExpired(store, logger)
		}
	}
}

func cleanupExpired(store *DiskFileStore, logger *zap.Logger) {
	err := filepath.Walk(store.BasePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip inaccessible entries
		}
		if info.IsDir() || !strings.HasSuffix(path, ".meta") {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}

		var meta fileMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			return nil
		}

		if time.Now().Unix() > meta.ExpirationUnix {
			// Derive the .bin path from the .meta path
			binPath := strings.TrimSuffix(path, ".meta") + ".bin"
			if err := os.Remove(binPath); err != nil && !os.IsNotExist(err) {
				logger.Warn("Failed to remove expired file", zap.String("path", binPath), zap.Error(err))
			}
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				logger.Warn("Failed to remove expired meta", zap.String("path", path), zap.Error(err))
			}
			logger.Debug("Cleaned up expired file", zap.String("key", filepath.Base(strings.TrimSuffix(path, ".meta"))))
		}
		return nil
	})
	if err != nil {
		logger.Warn("Error during file store cleanup", zap.Error(err))
	}
}

// StartS3Cleanup runs a background goroutine that periodically removes expired
// objects from the S3 file store by checking the yopass-expires tag.
func StartS3Cleanup(ctx context.Context, store *S3FileStore, interval time.Duration, logger *zap.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanupExpiredS3(ctx, store, logger)
		}
	}
}

func cleanupExpiredS3(ctx context.Context, store *S3FileStore, logger *zap.Logger) {
	now := time.Now().Unix()
	var continuationToken *string

	for {
		input := &s3.ListObjectsV2Input{
			Bucket: aws.String(store.bucket),
			Prefix: aws.String(store.prefix),
		}
		if continuationToken != nil {
			input.ContinuationToken = continuationToken
		}

		output, err := store.client.ListObjectsV2(ctx, input)
		if err != nil {
			logger.Warn("S3 cleanup: failed to list objects", zap.Error(err))
			return
		}

		for _, obj := range output.Contents {
			if obj.Key == nil {
				continue
			}
			key := *obj.Key

			tagOutput, err := store.client.GetObjectTagging(ctx, &s3.GetObjectTaggingInput{
				Bucket: aws.String(store.bucket),
				Key:    aws.String(key),
			})
			if err != nil {
				logger.Debug("S3 cleanup: failed to get tags", zap.String("key", key), zap.Error(err))
				continue
			}

			for _, tag := range tagOutput.TagSet {
				if tag.Key != nil && *tag.Key == "yopass-expires" && tag.Value != nil {
					expiresUnix, err := strconv.ParseInt(*tag.Value, 10, 64)
					if err != nil {
						logger.Debug("S3 cleanup: invalid expires tag", zap.String("key", key), zap.String("value", *tag.Value))
						continue
					}
					if now > expiresUnix {
						if _, err := store.client.DeleteObject(ctx, &s3.DeleteObjectInput{
							Bucket: aws.String(store.bucket),
							Key:    aws.String(key),
						}); err != nil {
							logger.Warn("S3 cleanup: failed to delete expired object", zap.String("key", key), zap.Error(err))
						} else {
							logger.Debug("Cleaned up expired S3 object", zap.String("key", key))
						}
					}
					break
				}
			}
		}

		if output.IsTruncated == nil || !*output.IsTruncated {
			break
		}
		continuationToken = output.NextContinuationToken
	}
}
