package permissions_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/moadabdou/Kith/api/pkg/permissions"
)

type TestCase struct {
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	GuildID     int64                   `json:"guild_id"`
	OwnerID     int64                   `json:"owner_id"`
	UserID      int64                   `json:"user_id"`
	Roles       []permissions.Role      `json:"roles"`
	Overwrites  []permissions.Overwrite `json:"overwrites"`
	Expected    uint64                  `json:"expected"`
}

func loadTestVectors(t *testing.T) []TestCase {
	t.Helper()

	candidates := []string{
		"../../../testvectors/permissions_vectors.json",
		"../../testvectors/permissions_vectors.json",
		"../testvectors/permissions_vectors.json",
		"testvectors/permissions_vectors.json",
	}

	var data []byte
	var err error
	var foundPath string

	for _, p := range candidates {
		abs, errAbs := filepath.Abs(p)
		if errAbs == nil {
			if b, readErr := os.ReadFile(abs); readErr == nil {
				data = b
				foundPath = abs
				break
			}
		}
	}

	if data == nil {
		t.Fatalf("could not locate testvectors/permissions_vectors.json, tried candidates: %v, last err: %v", candidates, err)
	}

	var cases []TestCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("failed to parse test vectors from %s: %v", foundPath, err)
	}

	return cases
}

func TestResolveGoldenVectors(t *testing.T) {
	cases := loadTestVectors(t)

	if len(cases) < 40 {
		t.Fatalf("expected at least 40 test cases in golden vector suite, got %d", len(cases))
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.Name, func(t *testing.T) {
			got := permissions.Resolve(tc.GuildID, tc.OwnerID, tc.UserID, tc.Roles, tc.Overwrites)
			if got != tc.Expected {
				t.Errorf("%s failed:\n  expected: %d (0b%b)\n  got:      %d (0b%b)\n  desc:     %s",
					tc.Name, tc.Expected, tc.Expected, got, got, tc.Description)
			}
		})
	}
}

func TestHasPermission(t *testing.T) {
	perms := permissions.VIEW_CHANNEL | permissions.SEND_MESSAGES | permissions.ATTACH_FILES

	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		t.Errorf("expected Has() to be true for VIEW_CHANNEL")
	}
	if !permissions.Has(perms, permissions.SEND_MESSAGES) {
		t.Errorf("expected Has() to be true for SEND_MESSAGES")
	}
	if !permissions.Has(perms, permissions.ATTACH_FILES) {
		t.Errorf("expected Has() to be true for ATTACH_FILES")
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL|permissions.SEND_MESSAGES) {
		t.Errorf("expected Has() to be true for combined VIEW_CHANNEL | SEND_MESSAGES")
	}
	if permissions.Has(perms, permissions.BAN_MEMBERS) {
		t.Errorf("expected Has() to be false for BAN_MEMBERS")
	}
	if permissions.Has(perms, permissions.ADMINISTRATOR) {
		t.Errorf("expected Has() to be false for ADMINISTRATOR")
	}
	if permissions.Has(perms, permissions.VIEW_CHANNEL|permissions.BAN_MEMBERS) {
		t.Errorf("expected Has() to be false when one required permission is missing")
	}
}

func TestCanonicalBitConstants(t *testing.T) {
	constants := []struct {
		name  string
		value uint64
		bit   int
	}{
		{"CREATE_INSTANT_INVITE", permissions.CREATE_INSTANT_INVITE, 0},
		{"KICK_MEMBERS", permissions.KICK_MEMBERS, 1},
		{"BAN_MEMBERS", permissions.BAN_MEMBERS, 2},
		{"ADMINISTRATOR", permissions.ADMINISTRATOR, 3},
		{"MANAGE_CHANNELS", permissions.MANAGE_CHANNELS, 4},
		{"MANAGE_GUILD", permissions.MANAGE_GUILD, 5},
		{"ADD_REACTIONS", permissions.ADD_REACTIONS, 6},
		{"VIEW_AUDIT_LOG", permissions.VIEW_AUDIT_LOG, 7},
		{"PRIORITY_SPEAKER", permissions.PRIORITY_SPEAKER, 8},
		{"STREAM", permissions.STREAM, 9},
		{"VIEW_CHANNEL", permissions.VIEW_CHANNEL, 10},
		{"SEND_MESSAGES", permissions.SEND_MESSAGES, 11},
		{"SEND_TTS_MESSAGES", permissions.SEND_TTS_MESSAGES, 12},
		{"MANAGE_MESSAGES", permissions.MANAGE_MESSAGES, 13},
		{"EMBED_LINKS", permissions.EMBED_LINKS, 14},
		{"ATTACH_FILES", permissions.ATTACH_FILES, 15},
		{"READ_MESSAGE_HISTORY", permissions.READ_MESSAGE_HISTORY, 16},
		{"MENTION_EVERYONE", permissions.MENTION_EVERYONE, 17},
		{"USE_EXTERNAL_EMOJIS", permissions.USE_EXTERNAL_EMOJIS, 18},
		{"VIEW_GUILD_INSIGHTS", permissions.VIEW_GUILD_INSIGHTS, 19},
		{"CONNECT", permissions.CONNECT, 20},
		{"SPEAK", permissions.SPEAK, 21},
		{"MUTE_MEMBERS", permissions.MUTE_MEMBERS, 22},
		{"DEAFEN_MEMBERS", permissions.DEAFEN_MEMBERS, 23},
		{"MOVE_MEMBERS", permissions.MOVE_MEMBERS, 24},
		{"USE_VAD", permissions.USE_VAD, 25},
		{"CHANGE_NICKNAME", permissions.CHANGE_NICKNAME, 26},
		{"MANAGE_NICKNAMES", permissions.MANAGE_NICKNAMES, 27},
		{"MANAGE_ROLES", permissions.MANAGE_ROLES, 28},
	}

	var combined uint64
	for _, c := range constants {
		expectedVal := uint64(1) << c.bit
		if c.value != expectedVal {
			t.Errorf("constant %s has value %d, expected 1 << %d = %d", c.name, c.value, c.bit, expectedVal)
		}
		if (combined & c.value) != 0 {
			t.Errorf("constant %s overlaps with previous bits", c.name)
		}
		combined |= c.value
	}

	if combined != permissions.ALL_PERMISSIONS {
		t.Errorf("union of all 29 constants = %d, expected ALL_PERMISSIONS = %d", combined, permissions.ALL_PERMISSIONS)
	}
	if permissions.ALL_PERMISSIONS != (1<<29)-1 {
		t.Errorf("ALL_PERMISSIONS = %d, expected (1 << 29) - 1 = %d", permissions.ALL_PERMISSIONS, (1<<29)-1)
	}

	fmt.Printf("Verified %d permission constants; ALL_PERMISSIONS = %d\n", len(constants), permissions.ALL_PERMISSIONS)
}
