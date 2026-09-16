package permissions

// Canonical Discord permission bit constants (1 << 0 through 1 << 28)
// Reference: plan/06-permissions.md and Discord API Permissions specification
const (
	CREATE_INSTANT_INVITE uint64 = 1 << 0
	KICK_MEMBERS          uint64 = 1 << 1
	BAN_MEMBERS           uint64 = 1 << 2
	ADMINISTRATOR         uint64 = 1 << 3
	MANAGE_CHANNELS       uint64 = 1 << 4
	MANAGE_GUILD          uint64 = 1 << 5
	ADD_REACTIONS         uint64 = 1 << 6
	VIEW_AUDIT_LOG        uint64 = 1 << 7
	PRIORITY_SPEAKER      uint64 = 1 << 8
	STREAM                uint64 = 1 << 9
	VIEW_CHANNEL          uint64 = 1 << 10
	SEND_MESSAGES         uint64 = 1 << 11
	SEND_TTS_MESSAGES     uint64 = 1 << 12
	MANAGE_MESSAGES       uint64 = 1 << 13
	EMBED_LINKS           uint64 = 1 << 14
	ATTACH_FILES          uint64 = 1 << 15
	READ_MESSAGE_HISTORY  uint64 = 1 << 16
	MENTION_EVERYONE      uint64 = 1 << 17
	USE_EXTERNAL_EMOJIS   uint64 = 1 << 18
	VIEW_GUILD_INSIGHTS   uint64 = 1 << 19
	CONNECT               uint64 = 1 << 20 // voice
	SPEAK                 uint64 = 1 << 21
	MUTE_MEMBERS          uint64 = 1 << 22
	DEAFEN_MEMBERS        uint64 = 1 << 23
	MOVE_MEMBERS          uint64 = 1 << 24
	USE_VAD               uint64 = 1 << 25
	CHANGE_NICKNAME       uint64 = 1 << 26
	MANAGE_NICKNAMES      uint64 = 1 << 27
	MANAGE_ROLES          uint64 = 1 << 28

	// ALL_PERMISSIONS is the bitmask of all 29 canonical permissions (bits 0 through 28).
	// Value: 536870911 (0x1FFFFFFF). Fits safely within JavaScript IEEE-754 numbers.
	ALL_PERMISSIONS uint64 = (1 << 29) - 1
)

// TargetType represents the target of a channel overwrite.
type TargetType int16

const (
	TargetTypeRole   TargetType = 0
	TargetTypeMember TargetType = 1
)

// Role represents a guild role with its assigned permissions.
type Role struct {
	ID          int64  `json:"id"`
	GuildID     int64  `json:"guild_id"`
	Name        string `json:"name"`
	Position    int    `json:"position"`
	Permissions uint64 `json:"permissions"`
}

// Overwrite represents a channel permission overwrite for a role or member.
type Overwrite struct {
	ChannelID  int64      `json:"channel_id"`
	TargetID   int64      `json:"target_id"`
	TargetType TargetType `json:"target_type"`
	Allow      uint64     `json:"allow"`
	Deny       uint64     `json:"deny"`
}

// Resolve computes the effective channel permissions for a guild member.
// It implements Discord's exact hierarchical override resolution as a pure,
// deterministic function:
//
// 1. Guild owner has all permissions (ALL_PERMISSIONS).
// 2. Base permissions are the bitwise OR of all member roles (including @everyone).
// 3. If ADMINISTRATOR is granted in base permissions, all channel overwrites are bypassed.
// 4. Channel overwrites are applied in order:
//    a. @everyone overwrite: (perms & ^deny) | allow
//    b. Member role overwrites: union all role denies, union all role allows,
//       stack without position bias, then (perms & ^roleDeny) | roleAllow.
//    c. Member-specific overwrite: (perms & ^memberDeny) | memberAllow.
func Resolve(guildID, ownerID, userID int64, roles []Role, overwrites []Overwrite) uint64 {
	// 1. Owner bypass
	if userID == ownerID {
		return ALL_PERMISSIONS
	}

	// 2. Base permissions: bitwise OR of all member roles (including @everyone)
	var base uint64
	for _, role := range roles {
		base |= role.Permissions
	}

	// 3. Administrator bypass
	if (base & ADMINISTRATOR) == ADMINISTRATOR {
		return ALL_PERMISSIONS
	}

	perms := base

	// 4a. Apply @everyone overwrite (target_type == 0, target_id == guildID)
	for _, ow := range overwrites {
		if ow.TargetType == TargetTypeRole && ow.TargetID == guildID {
			perms = (perms & ^ow.Deny) | ow.Allow
			break
		}
	}

	// 4b. Apply member role overwrites
	// Collect role IDs the member has (excluding @everyone which was handled in 4a)
	roleIDs := make(map[int64]struct{}, len(roles))
	for _, role := range roles {
		if role.ID != guildID {
			roleIDs[role.ID] = struct{}{}
		}
	}

	var roleDeny uint64
	var roleAllow uint64
	for _, ow := range overwrites {
		if ow.TargetType == TargetTypeRole && ow.TargetID != guildID {
			if _, ok := roleIDs[ow.TargetID]; ok {
				roleDeny |= ow.Deny
				roleAllow |= ow.Allow
			}
		}
	}
	perms = (perms & ^roleDeny) | roleAllow

	// 4c. Apply member-specific overwrite (target_type == 1, target_id == userID)
	for _, ow := range overwrites {
		if ow.TargetType == TargetTypeMember && ow.TargetID == userID {
			perms = (perms & ^ow.Deny) | ow.Allow
			break
		}
	}

	return perms
}

// Has checks whether the given permission bitmask includes the required permission(s).
func Has(perms uint64, permission uint64) bool {
	return (perms & permission) == permission
}
