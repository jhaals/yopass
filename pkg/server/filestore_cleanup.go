package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
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
	root, err := store.openRoot()
	if err != nil {
		logger.Warn("Error during file store cleanup", zap.Error(err))
		return
	}
	defer root.Close()

	// Walk through the root so a symlink planted in the store cannot point the
	// sweeper at metadata or blobs outside of it.
	tempFiles := map[string][]string{}
	err = fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip inaccessible entries
		}
		if entry.IsDir() {
			entries, readErr := fs.ReadDir(root.FS(), path)
			if readErr != nil {
				return fs.SkipDir
			}
			for _, item := range entries {
				if i := strings.LastIndex(item.Name(), ".tmp."); i >= 0 {
					base := filepath.Join(path, item.Name()[:i])
					tempFiles[base] = append(tempFiles[base], filepath.Join(path, item.Name()))
				}
			}
			return nil
		}
		if !entry.Type().IsRegular() || !strings.HasSuffix(path, ".meta") {
			return nil
		}

		data, err := root.ReadFile(path)
		if err != nil {
			return nil
		}

		var meta fileMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			return nil
		}

		if time.Now().Unix() > meta.ExpirationUnix {
			base := filepath.FromSlash(strings.TrimSuffix(path, ".meta"))
			key := filepath.Base(base)
			secretID := zap.String("secret_id", redactSecretID(key))
			// Unlink upload temps first so an expired active upload cannot publish a blob.
			for _, tmp := range tempFiles[base] {
				if err := root.Remove(tmp); err != nil && !os.IsNotExist(err) {
					logger.Warn("Failed to remove expired temp file", secretID, redactedError(err, key))
					return nil // Keep metadata so the next sweep retries deletion.
				}
			}
			binPath := base + ".bin"
			if err := root.Remove(binPath); err != nil && !os.IsNotExist(err) {
				logger.Warn("Failed to remove expired file", secretID, redactedError(err, key))
				return nil // Keep metadata so the next sweep retries blob deletion.
			}
			if err := root.Remove(path); err != nil && !os.IsNotExist(err) {
				logger.Warn("Failed to remove expired meta", secretID, redactedError(err, key))
			}
			logger.Debug("Cleaned up expired file", secretID)
		}
		return nil
	})
	if err != nil {
		logger.Warn("Error during file store cleanup", zap.Error(err))
	}
}

// StartS3Cleanup runs a background goroutine that periodically removes expired
// objects from the S3 file store by checking the Expires header set at upload.
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

const s3CleanupCallTimeout = 30 * time.Second

func cleanupExpiredS3(ctx context.Context, store *S3FileStore, logger *zap.Logger) {
	now := time.Now()
	var continuationToken *string

	for {
		input := &s3.ListObjectsV2Input{
			Bucket: aws.String(store.bucket),
			Prefix: aws.String(store.prefix),
		}
		if continuationToken != nil {
			input.ContinuationToken = continuationToken
		}

		callCtx, cancel := context.WithTimeout(ctx, s3CleanupCallTimeout)
		output, err := store.client.ListObjectsV2(callCtx, input)
		cancel()
		if err != nil {
			logger.Warn("S3 cleanup: failed to list objects", zap.Error(err))
			return
		}

		for _, obj := range output.Contents {
			if ctx.Err() != nil {
				return
			}
			if obj.Key == nil {
				continue
			}
			key := *obj.Key
			id := strings.TrimPrefix(key, store.prefix)
			secretID := zap.String("secret_id", redactSecretID(id))

			callCtx, cancel := context.WithTimeout(ctx, s3CleanupCallTimeout)
			head, err := store.client.HeadObject(callCtx, &s3.HeadObjectInput{
				Bucket: aws.String(store.bucket),
				Key:    aws.String(key),
			})
			cancel()
			if err != nil {
				logger.Debug("S3 cleanup: failed to head object", secretID, redactedError(err, id))
				continue
			}

			// Objects without an Expires header (e.g. uploaded externally or by
			// an older version) are left alone.
			if head.ExpiresString == nil {
				continue
			}
			expires, err := http.ParseTime(*head.ExpiresString)
			if err != nil {
				logger.Debug("S3 cleanup: invalid Expires header", secretID, zap.String("value", strings.ReplaceAll(*head.ExpiresString, id, redactSecretID(id))))
				continue
			}

			if now.After(expires) {
				callCtx, cancel := context.WithTimeout(ctx, s3CleanupCallTimeout)
				_, err := store.client.DeleteObject(callCtx, &s3.DeleteObjectInput{
					Bucket: aws.String(store.bucket),
					Key:    aws.String(key),
				})
				cancel()
				if err != nil {
					logger.Warn("S3 cleanup: failed to delete expired object", secretID, redactedError(err, id))
				} else {
					logger.Debug("Cleaned up expired S3 object", secretID)
				}
			}
		}

		if output.IsTruncated == nil || !*output.IsTruncated {
			break
		}
		continuationToken = output.NextContinuationToken
	}
}
