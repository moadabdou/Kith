package messages

import (
	"reflect"
	"testing"
)

func TestParseMentions(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    ParsedMentions
	}{
		{
			name:    "empty content",
			content: "",
			want:    ParsedMentions{},
		},
		{
			name:    "plain text",
			content: "hello world, no mentions here",
			want:    ParsedMentions{},
		},
		{
			name:    "single user mention",
			content: "hey <@12345> look",
			want:    ParsedMentions{UserIDs: []int64{12345}},
		},
		{
			name:    "nickname user mention",
			content: "hey <@!67890> look",
			want:    ParsedMentions{UserIDs: []int64{67890}},
		},
		{
			name:    "role mention",
			content: "ping <@&4242> please",
			want:    ParsedMentions{RoleIDs: []int64{4242}},
		},
		{
			name:    "mixed duplicates deduped and sorted",
			content: "<@300> and <@100> and <@300> plus <@&9> and <@&9>",
			want:    ParsedMentions{UserIDs: []int64{100, 300}, RoleIDs: []int64{9}},
		},
		{
			name:    "broadcast flags",
			content: "@everyone standup time",
			want:    ParsedMentions{Everyone: true},
		},
		{
			name:    "here flag",
			content: "anyone @here?",
			want:    ParsedMentions{Here: true},
		},
		{
			name:    "malformed syntax ignored",
			content: "hello <@> and <@&> and <@abc> and <> ok",
			want:    ParsedMentions{},
		},
		{
			name:    "overflow id skipped",
			content: "hey <@99999999999999999999999> ok",
			want:    ParsedMentions{},
		},
		{
			name:    "role syntax not parsed as user",
			content: "<@&555>",
			want:    ParsedMentions{RoleIDs: []int64{555}},
		},
		{
			name:    "custom emoji not parsed as mention",
			content: "nice <:party:12345> and <a:wave:678>",
			want:    ParsedMentions{},
		},
		{
			name:    "zero id skipped",
			content: "hey <@0> ok",
			want:    ParsedMentions{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseMentions(tc.content)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParseMentions(%q) = %+v, want %+v", tc.content, got, tc.want)
			}
			if tc.want.Empty() != got.Empty() {
				t.Fatalf("Empty() = %v, want %v", got.Empty(), tc.want.Empty())
			}
		})
	}
}

func TestResolveMentionsNilDBTrustsParsed(t *testing.T) {
	// Unit-test mode (nil DB, mirroring requireChannelPerms ALL_PERMISSIONS):
	// parsed IDs pass through unfiltered.
	svc := &Service{}
	got, err := svc.resolveMentions(t.Context(), 7, 0, "hi <@11> and <@&22> @everyone")
	if err != nil {
		t.Fatalf("resolveMentions returned error: %v", err)
	}
	if !reflect.DeepEqual(got.UserIDs, []int64{11}) {
		t.Fatalf("UserIDs = %v, want [11]", got.UserIDs)
	}
	if !reflect.DeepEqual(got.RoleIDs, []int64{22}) {
		t.Fatalf("RoleIDs = %v, want [22]", got.RoleIDs)
	}
	if !got.Everyone {
		t.Fatalf("Everyone = false, want true")
	}
}

func TestResolveMentionsNoGuild(t *testing.T) {
	svc := &Service{}
	got, err := svc.resolveMentions(t.Context(), 0, 0, "hi <@11> @everyone")
	if err != nil {
		t.Fatalf("resolveMentions returned error: %v", err)
	}
	if !got.Empty() {
		t.Fatalf("expected empty resolution without guild context, got %+v", got)
	}
}

func TestApplyMentionsWireShape(t *testing.T) {
	m := &Message{}
	m.applyMentions(ResolvedMentions{UserIDs: []int64{5, 9}, RoleIDs: []int64{3}, Everyone: true})
	if !reflect.DeepEqual(m.Mentions, []string{"5", "9"}) {
		t.Fatalf("Mentions = %v", m.Mentions)
	}
	if !reflect.DeepEqual(m.MentionRoles, []string{"3"}) {
		t.Fatalf("MentionRoles = %v", m.MentionRoles)
	}
	if !m.MentionEveryone {
		t.Fatalf("MentionEveryone = false")
	}

	empty := &Message{}
	empty.applyMentions(ResolvedMentions{})
	if empty.Mentions != nil || empty.MentionRoles != nil || empty.MentionEveryone {
		t.Fatalf("empty resolution must leave omitempty fields unset: %+v", empty)
	}
}
