// Package messages — mention parsing and resolution (Issue #121).
//
// Two stages, split for testability:
//
//  1. ParseMentions: pure content parsing, no I/O. Extracts user/role ID
//     candidates and broadcast flags from Discord mention syntax.
//  2. Service.resolveMentions: validates candidates against guild state
//     (membership, role mentionable flags, MENTION_EVERYONE). Content is
//     never mutated — unauthorized mentions are excluded from the resolved
//     set only, so they neither ping nor highlight downstream.
package messages

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/moadabdou/Kith/api/pkg/permissions"
)

var (
	userMentionPattern = regexp.MustCompile(`<@!?([0-9]{1,20})>`)
	roleMentionPattern = regexp.MustCompile(`<@&([0-9]{1,20})>`)
)

// ParsedMentions is the raw, unvalidated mention content of a message.
type ParsedMentions struct {
	UserIDs  []int64
	RoleIDs  []int64
	Everyone bool
	Here     bool
}

// Empty reports whether no mention syntax was found at all.
func (p ParsedMentions) Empty() bool {
	return len(p.UserIDs) == 0 && len(p.RoleIDs) == 0 && !p.Everyone && !p.Here
}

// ParseMentions extracts mention candidates from message content.
// IDs are deduplicated and sorted for deterministic output. Unparseable
// IDs (overflow, non-numeric) are skipped, never fatal.
func ParseMentions(content string) ParsedMentions {
	var p ParsedMentions
	if content == "" {
		return p
	}
	p.UserIDs = distinctMentionIDs(userMentionPattern.FindAllStringSubmatch(content, -1))
	p.RoleIDs = distinctMentionIDs(roleMentionPattern.FindAllStringSubmatch(content, -1))
	p.Everyone = strings.Contains(content, "@everyone")
	p.Here = strings.Contains(content, "@here")
	return p
}

func distinctMentionIDs(matches [][]string) []int64 {
	set := make(map[int64]struct{})
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		if id, err := strconv.ParseInt(m[1], 10, 64); err == nil && id > 0 {
			set[id] = struct{}{}
		}
	}
	if len(set) == 0 {
		return nil
	}
	out := make([]int64, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// ResolvedMentions is the validated, storable mention set for a message.
// Only authorized mentions are present: membership-checked users,
// mentionable (or bypass-authorized) roles, and a broadcast flag gated
// on MENTION_EVERYONE.
type ResolvedMentions struct {
	UserIDs  []int64
	RoleIDs  []int64
	Everyone bool
}

// Empty reports whether nothing mentionable survived validation.
func (r ResolvedMentions) Empty() bool {
	return len(r.UserIDs) == 0 && len(r.RoleIDs) == 0 && !r.Everyone
}

// resolveMentions validates parsed mention candidates against guild state.
// The fast path (no mention syntax) performs zero queries. A nil database
// (unit-test mode, mirroring requireChannelPerms' ALL_PERMISSIONS) trusts
// parsed IDs as-is. Validation failures fail closed: the caller surfaces a
// 500 rather than silently dropping someone's ping.
func (s *Service) resolveMentions(ctx context.Context, guildID int64, perms uint64, content string) (ResolvedMentions, error) {
	var out ResolvedMentions
	parsed := ParseMentions(content)
	if parsed.Empty() || guildID <= 0 {
		return out, nil
	}
	if s.db == nil {
		out.UserIDs = parsed.UserIDs
		out.RoleIDs = parsed.RoleIDs
		out.Everyone = parsed.Everyone || parsed.Here
		return out, nil
	}

	canBroadcast := permissions.Has(perms, permissions.MENTION_EVERYONE)

	if len(parsed.UserIDs) > 0 {
		rows, err := s.db.QueryContext(ctx,
			`SELECT user_id FROM members WHERE guild_id = $1 AND user_id = ANY($2)`,
			guildID, parsed.UserIDs)
		if err != nil {
			return out, err
		}
		var kept []int64
		for rows.Next() {
			var uid int64
			if err := rows.Scan(&uid); err != nil {
				rows.Close()
				return out, err
			}
			kept = append(kept, uid)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return out, err
		}
		sort.Slice(kept, func(i, j int) bool { return kept[i] < kept[j] })
		out.UserIDs = kept
	}

	if len(parsed.RoleIDs) > 0 {
		rows, err := s.db.QueryContext(ctx,
			`SELECT id, mentionable FROM roles WHERE guild_id = $1 AND id = ANY($2)`,
			guildID, parsed.RoleIDs)
		if err != nil {
			return out, err
		}
		var kept []int64
		for rows.Next() {
			var rid int64
			var mentionable bool
			if err := rows.Scan(&rid, &mentionable); err != nil {
				rows.Close()
				return out, err
			}
			// Discord semantics: a role pings when mentionable, or when the
			// sender holds "Mention @everyone, @here, and All Roles".
			if mentionable || canBroadcast {
				kept = append(kept, rid)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return out, err
		}
		sort.Slice(kept, func(i, j int) bool { return kept[i] < kept[j] })
		out.RoleIDs = kept
	}

	out.Everyone = (parsed.Everyone || parsed.Here) && canBroadcast
	return out, nil
}

// applyMentions stamps resolved mentions onto the wire shape as snowflake
// strings. Empty sets stay nil so `omitempty` drops them from the payload.
func (m *Message) applyMentions(r ResolvedMentions) {
	m.Mentions = formatMentionIDs(r.UserIDs)
	m.MentionRoles = formatMentionIDs(r.RoleIDs)
	m.MentionEveryone = r.Everyone
}

func formatMentionIDs(ids []int64) []string {
	if len(ids) == 0 {
		return nil
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, strconv.FormatInt(id, 10))
	}
	return out
}

// nonNilIDs normalizes nil to an empty array for storage writes:
// Postgres columns are NOT NULL, and Scylla empty-list writes keep reads uniform.
func nonNilIDs(ids []int64) []int64 {
	if ids == nil {
		return []int64{}
	}
	return ids
}

// parseMentionIDs converts wire snowflake strings back to storage int64s
// for the Postgres/Scylla writes. Unparseable entries are skipped.
func parseMentionIDs(strs []string) []int64 {
	if len(strs) == 0 {
		return nil
	}
	out := make([]int64, 0, len(strs))
	for _, s := range strs {
		if id, err := strconv.ParseInt(s, 10, 64); err == nil && id > 0 {
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// scanPGArrayLiteral parses a Postgres array literal ('{1,2,3}') as returned
// in text form by database/sql drivers that hand arrays back as strings.
// NULL/empty yields nil.
func scanPGArrayLiteral(s string) []int64 {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return nil
	}
	inner := strings.TrimSpace(s[1 : len(s)-1])
	if inner == "" {
		return nil
	}
	var out []int64
	for _, part := range strings.Split(inner, ",") {
		part = strings.TrimSpace(part)
		if id, err := strconv.ParseInt(part, 10, 64); err == nil && id > 0 {
			out = append(out, id)
		}
	}
	return out
}
