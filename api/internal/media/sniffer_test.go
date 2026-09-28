package media

import (
	"testing"
)

func TestDetectAndValidateMIME(t *testing.T) {
	tests := []struct {
		name          string
		head          []byte
		filename      string
		wantMIME      string
		wantExt       string
		wantErr       error
		expectBlocked bool
	}{
		{
			name:     "valid png",
			head:     []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"),
			filename: "screenshot.png",
			wantMIME: "image/png",
			wantExt:  ".png",
		},
		{
			name:     "valid jpeg",
			head:     []byte("\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01"),
			filename: "photo.jpg",
			wantMIME: "image/jpeg",
			wantExt:  ".jpg",
		},
		{
			name:     "valid jpeg with .jpeg extension",
			head:     []byte("\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01"),
			filename: "photo.jpeg",
			wantMIME: "image/jpeg",
			wantExt:  ".jpeg",
		},
		{
			name:     "jpeg disguised as png (canonical normalization)",
			head:     []byte("\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01"),
			filename: "spoofed.png",
			wantMIME: "image/jpeg",
			wantExt:  ".jpg",
		},
		{
			name:          "windows PE executable rejected",
			head:          []byte("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00"),
			filename:      "harmless.png",
			expectBlocked: true,
			wantErr:       ErrDangerousFile,
		},
		{
			name:          "linux ELF binary rejected",
			head:          []byte("\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00"),
			filename:      "avatar.jpg",
			expectBlocked: true,
			wantErr:       ErrDangerousFile,
		},
		{
			name:          "mach-o binary rejected",
			head:          []byte("\xfe\xed\xfa\xce\x00\x00\x00\x00"),
			filename:      "update.bin",
			expectBlocked: true,
			wantErr:       ErrDangerousFile,
		},
		{
			name:          "shell script shebang rejected",
			head:          []byte("#!/bin/bash\nrm -rf /"),
			filename:      "script.sh",
			expectBlocked: true,
			wantErr:       ErrDangerousFile,
		},
		{
			name:          "empty payload",
			head:          []byte{},
			filename:      "empty.txt",
			expectBlocked: true,
			wantErr:       ErrEmptyFile,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mime, ext, cleanName, err := DetectAndValidateMIME(tt.head, tt.filename)
			if tt.expectBlocked {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				if tt.wantErr != nil && err != tt.wantErr {
					t.Fatalf("expected error %v, got %v", tt.wantErr, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if mime != tt.wantMIME {
				t.Errorf("mime mismatch: got %q, want %q", mime, tt.wantMIME)
			}
			if ext != tt.wantExt {
				t.Errorf("ext mismatch: got %q, want %q", ext, tt.wantExt)
			}
			if cleanName == "" {
				t.Errorf("expected cleanName not to be empty")
			}
		})
	}
}

func TestFormatAttachmentKey(t *testing.T) {
	key := FormatAttachmentKey("123", "456", "abcde12345", ".png")
	expected := "attachments/123/456/abcde12345.png"
	if key != expected {
		t.Errorf("got %q, want %q", key, expected)
	}
}
