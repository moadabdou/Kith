package media

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
)

var (
	ErrDangerousFile  = errors.New("media: executable or prohibited file type rejected")
	ErrFileTooLarge   = errors.New("media: file exceeds maximum allowed size")
	ErrInvalidFile    = errors.New("media: invalid or corrupt file upload")
	ErrEmptyFile      = errors.New("media: empty file payload")
	ErrExtensionSpoof = errors.New("media: file extension does not match detected content type")
)

// ProhibitedMIMETypes lists MIME types strictly rejected for upload.
var ProhibitedMIMETypes = map[string]bool{
	"application/x-executable":  true,
	"application/x-dosexec":     true,
	"application/x-mach-binary": true,
	"application/x-sharedlib":   true,
	"application/x-msdownload":  true,
	"application/x-bat":         true,
	"application/x-sh":          true,
	"application/x-shellscript": true,
	"text/x-php":                true,
	"text/x-python":             true,
	"text/x-perl":               true,
}

// CanonicalMIMEs maps common detected MIME types to their canonical file extension.
var CanonicalMIMEs = map[string]string{
	"image/jpeg":       ".jpg",
	"image/png":        ".png",
	"image/gif":        ".gif",
	"image/webp":       ".webp",
	"image/avif":       ".avif",
	"video/mp4":        ".mp4",
	"video/webm":       ".webm",
	"video/quicktime":  ".mov",
	"audio/mpeg":       ".mp3",
	"audio/ogg":        ".ogg",
	"audio/wav":        ".wav",
	"audio/webm":       ".weba",
	"application/pdf":  ".pdf",
	"application/zip":  ".zip",
	"application/gzip": ".gz",
	"text/plain":       ".txt",
}

// DetectAndValidateMIME inspects the first 512 bytes (or fewer) and filename,
// returning the verified MIME type, canonical extension, and sanitized filename.
func DetectAndValidateMIME(head []byte, declaredFilename string) (contentType, ext, cleanFilename string, err error) {
	if len(head) == 0 {
		return "", "", "", ErrEmptyFile
	}

	// 1. Magic byte checks for executables & scripts
	if isExecutableMagic(head) {
		return "", "", "", ErrDangerousFile
	}

	// 2. Standard Go HTTP content sniffing (up to 512 bytes)
	detected := http.DetectContentType(head)
	// Strip parameters (e.g., text/plain; charset=utf-8 -> text/plain)
	if idx := strings.Index(detected, ";"); idx != -1 {
		detected = strings.TrimSpace(detected[:idx])
	}

	if ProhibitedMIMETypes[detected] {
		return "", "", "", ErrDangerousFile
	}

	// 3. Clean and sanitize filename
	cleanFilename = filepath.Base(filepath.Clean(declaredFilename))
	cleanFilename = strings.ReplaceAll(cleanFilename, "\\", "")
	cleanFilename = strings.ReplaceAll(cleanFilename, "/", "")
	cleanFilename = strings.TrimSpace(cleanFilename)
	if cleanFilename == "" || cleanFilename == "." {
		cleanFilename = "attachment"
	}
	if len(cleanFilename) > 200 {
		cleanFilename = cleanFilename[:200]
	}

	rawExt := strings.ToLower(filepath.Ext(cleanFilename))

	// 4. Resolve extension with MIME enforcement
	if canonExt, ok := CanonicalMIMEs[detected]; ok {
		// If declared extension is compatible with the detected type (e.g. .jpeg vs .jpg), allow it
		if isCompatibleExtension(rawExt, detected) {
			ext = rawExt
		} else {
			// Extension spoofing check: if the client claimed a media extension (e.g. .png)
			// but sniffed is different media (e.g. image/jpeg), we use the canonical extension.
			// If client claimed something completely different, enforce canonical.
			ext = canonExt
		}
	} else {
		// If generic/octet-stream or other document, preserve raw extension if not empty
		if rawExt != "" {
			// Disallow executable extensions even if MIME detection was ambiguous
			if isExecutableExt(rawExt) {
				return "", "", "", ErrDangerousFile
			}
			ext = rawExt
		} else {
			ext = ".bin"
		}
	}

	// Ensure filename has the determined extension
	if !strings.HasSuffix(strings.ToLower(cleanFilename), ext) {
		cleanFilename = strings.TrimSuffix(cleanFilename, filepath.Ext(cleanFilename)) + ext
	}

	return detected, ext, cleanFilename, nil
}

func isExecutableMagic(b []byte) bool {
	// Windows PE / DOS: "MZ" (0x4D, 0x5A)
	if len(b) >= 2 && b[0] == 0x4D && b[1] == 0x5A {
		return true
	}
	// Linux ELF: 0x7F 'E' 'L' 'F'
	if len(b) >= 4 && b[0] == 0x7F && b[1] == 'E' && b[2] == 'L' && b[3] == 'F' {
		return true
	}
	// macOS Mach-O (32-bit & 64-bit, big & little endian)
	if len(b) >= 4 {
		m := b[:4]
		if bytes.Equal(m, []byte{0xFE, 0xED, 0xFA, 0xCE}) ||
			bytes.Equal(m, []byte{0xFE, 0xED, 0xFA, 0xCF}) ||
			bytes.Equal(m, []byte{0xCE, 0xFA, 0xED, 0xFE}) ||
			bytes.Equal(m, []byte{0xCF, 0xFA, 0xED, 0xFE}) {
			return true
		}
	}
	// Shell script shebang "#!"
	if len(b) >= 2 && b[0] == '#' && b[1] == '!' {
		return true
	}
	return false
}

func isExecutableExt(ext string) bool {
	switch ext {
	case ".exe", ".dll", ".so", ".dylib", ".bat", ".cmd", ".sh", ".bash", ".ps1", ".vbs", ".msi", ".com", ".scr", ".bin":
		return true
	default:
		return false
	}
}

func isCompatibleExtension(ext, mimeType string) bool {
	switch mimeType {
	case "image/jpeg":
		return ext == ".jpg" || ext == ".jpeg" || ext == ".jpe"
	case "image/png":
		return ext == ".png"
	case "image/gif":
		return ext == ".gif"
	case "image/webp":
		return ext == ".webp"
	case "video/mp4":
		return ext == ".mp4" || ext == ".m4v"
	case "video/quicktime":
		return ext == ".mov"
	case "audio/mpeg":
		return ext == ".mp3"
	case "application/pdf":
		return ext == ".pdf"
	case "application/zip":
		return ext == ".zip"
	default:
		return false
	}
}

// FormatAttachmentKey builds the content-addressed immutable path:
// attachments/{channel_id}/{attachment_id}/{sha256}{ext}
func FormatAttachmentKey(channelID, attachmentID, sha256Hex, ext string) string {
	ext = strings.ToLower(ext)
	if ext != "" && !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	return fmt.Sprintf("attachments/%s/%s/%s%s", channelID, attachmentID, sha256Hex, ext)
}

// FormatTempKey builds a temporary S3 key for in-flight direct uploads:
// attachments/{channel_id}/{attachment_id}/temp{ext}
func FormatTempKey(channelID, attachmentID, ext string) string {
	ext = strings.ToLower(ext)
	if ext != "" && !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	return fmt.Sprintf("attachments/%s/%s/temp%s", channelID, attachmentID, ext)
}
