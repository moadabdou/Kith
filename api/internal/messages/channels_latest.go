package messages

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/moadabdou/Kith/api/pkg/permissions"
	"golang.org/x/sync/errgroup"
)

// ChannelLatest is the newest message cursor for a channel — the missing
// half of the unread comparison on login/refresh (Issue #105). The client
// already hydrates read states via GET /users/@me/read-states; this bulk
// endpoint hydrates the other side (latest per channel) in one round trip.
type ChannelLatest struct {
	ChannelID     string `json:"channel_id"`
	LastMessageID string `json:"last_message_id"`
}

// channelsLatestFanout caps concurrent Scylla LIMIT 1 reads so a guild with
// many channels degrades to a few sequential batches instead of a partition
// storm on every client login.
const channelsLatestFanout = 8

// channelsLatestTimeout bounds each per-channel tail read; a single slow
// partition must not stall the whole hydration response.
const channelsLatestTimeout = 2 * time.Second

// GetChannelsLatest returns the newest message id for every text channel in
// the guild the user can read. Channels without messages are omitted (the
// client treats a missing latest as not-unread, which is correct for empty
// channels). Per-channel store errors are fail-soft: logged and skipped so
// one bad partition yields a partial result instead of a 500.
func (s *Service) GetChannelsLatest(ctx context.Context, userID, guildID int64) ([]ChannelLatest, error) {
	if s.db == nil {
		return nil, errors.New("messages: GetChannelsLatest requires database")
	}
	visible, err := s.visibleTextChannels(ctx, userID, guildID)
	if err != nil {
		return nil, err
	}
	if len(visible) == 0 {
		return []ChannelLatest{}, nil
	}

	results := make([]ChannelLatest, len(visible))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(channelsLatestFanout)
	for i, cid := range visible {
		g.Go(func() error {
			cctx, cancel := context.WithTimeout(ctx, channelsLatestTimeout)
			defer cancel()
			msgs, err := s.store.List(cctx, cid, Cursor{}, 1)
			if err != nil {
				slog.WarnContext(ctx, "channels latest: tail read failed, skipping channel",
					"guild_id", guildID, "channel_id", cid, "error", err)
				return nil
			}
			if len(msgs) == 0 {
				return nil
			}
			results[i] = ChannelLatest{
				ChannelID:     strconv.FormatInt(cid, 10),
				LastMessageID: msgs[0].ID,
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}

	out := make([]ChannelLatest, 0, len(results))
	for _, r := range results {
		if r.ChannelID != "" {
			out = append(out, r)
		}
	}
	return out, nil
}

// visibleTextChannels resolves the text (type=0) channels the user may read,
// mirroring guilds.Service.ListChannels filtering without a cross-package
// dependency: owner/ADMINISTRATOR bypass, otherwise member + per-channel
// VIEW_CHANNEL + READ_MESSAGE_HISTORY resolution (same gate as Service.List,
// so the bulk cursor leaks nothing List(limit=1) would not).
func (s *Service) visibleTextChannels(ctx context.Context, userID, guildID int64) ([]int64, error) {
	var ownerID int64
	err := s.db.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		// Unknown guild reads as missing access — same posture as
		// requireChannelPerms: never leak guild existence to strangers.
		return nil, ErrMissingAccess
	}
	if err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, type FROM channels WHERE guild_id = $1`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type channelRow struct {
		id    int64
		ctype int16
	}
	var textChannels []int64
	for rows.Next() {
		var c channelRow
		if err := rows.Scan(&c.id, &c.ctype); err != nil {
			return nil, err
		}
		if c.ctype == 0 {
			textChannels = append(textChannels, c.id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(textChannels) == 0 {
		return nil, nil
	}

	// Owner sees everything without further probes.
	if userID == ownerID {
		return textChannels, nil
	}

	var isMember bool
	err = s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&isMember)
	if err != nil {
		return nil, err
	}
	if !isMember {
		return nil, ErrMissingAccess
	}

	callerRoles, isAdmin, err := s.latestCallerRoles(ctx, guildID, userID)
	if err != nil {
		return nil, err
	}
	// ADMINISTRATOR bypasses channel overwrites (same as Resolve).
	if isAdmin {
		return textChannels, nil
	}
	overwritesByChannel, err := s.latestGuildOverwrites(ctx, guildID)
	if err != nil {
		return nil, err
	}

	visible := make([]int64, 0, len(textChannels))
	for _, cid := range textChannels {
		resolved := permissions.Resolve(guildID, ownerID, userID, callerRoles, overwritesByChannel[cid])
		if permissions.Has(resolved, permissions.VIEW_CHANNEL) &&
			permissions.Has(resolved, permissions.READ_MESSAGE_HISTORY) {
			visible = append(visible, cid)
		}
	}
	return visible, nil
}

// latestCallerRoles loads the caller's @everyone + assigned roles for
// permission resolution, defaulting to DEFAULT_EVERYONE_PERMISSIONS when the
// @everyone row is absent. isAdmin reports an ADMINISTRATOR grant, which
// bypasses channel overwrites entirely.
func (s *Service) latestCallerRoles(ctx context.Context, guildID, userID int64) (roles []permissions.Role, isAdmin bool, err error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id, r.position, r.permissions
		FROM roles r
		WHERE r.id = $1 AND r.guild_id = $1
		UNION
		SELECT r.id, r.position, r.permissions
		FROM roles r
		JOIN member_roles mr ON mr.role_id = r.id
		WHERE mr.guild_id = $1 AND mr.user_id = $2`,
		guildID, userID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	callerRoles := make([]permissions.Role, 0)
	var hasEveryone bool
	var callerPerms uint64
	for rows.Next() {
		var rid int64
		var pos int32
		var p uint64
		if err := rows.Scan(&rid, &pos, &p); err != nil {
			return nil, false, err
		}
		if rid == guildID {
			hasEveryone = true
		}
		callerPerms |= p
		callerRoles = append(callerRoles, permissions.Role{
			ID:          rid,
			GuildID:     guildID,
			Position:    int(pos),
			Permissions: p,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if !hasEveryone {
		callerRoles = append(callerRoles, permissions.Role{
			ID:          guildID,
			GuildID:     guildID,
			Position:    0,
			Permissions: permissions.DEFAULT_EVERYONE_PERMISSIONS,
		})
		callerPerms |= permissions.DEFAULT_EVERYONE_PERMISSIONS
	}
	if permissions.Has(callerPerms, permissions.ADMINISTRATOR) {
		// ADMINISTRATOR bypasses channel overwrites in Resolve, but
		// short-circuit here to skip per-channel resolution entirely.
		return nil, true, nil
	}
	return callerRoles, false, nil
}

// latestGuildOverwrites loads all channel overwrites in the guild grouped by
// channel.
func (s *Service) latestGuildOverwrites(ctx context.Context, guildID int64) (map[int64][]permissions.Overwrite, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT co.channel_id, co.target_id, co.target_type, co.allow, co.deny
		FROM channel_overwrites co
		JOIN channels c ON c.id = co.channel_id
		WHERE c.guild_id = $1`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byChannel := make(map[int64][]permissions.Overwrite)
	for rows.Next() {
		var cid, tid int64
		var ttype int16
		var a, d uint64
		if err := rows.Scan(&cid, &tid, &ttype, &a, &d); err != nil {
			return nil, err
		}
		byChannel[cid] = append(byChannel[cid], permissions.Overwrite{
			ChannelID:  cid,
			TargetID:   tid,
			TargetType: permissions.TargetType(ttype),
			Allow:      a,
			Deny:       d,
		})
	}
	return byChannel, rows.Err()
}
