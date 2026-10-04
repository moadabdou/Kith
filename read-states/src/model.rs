use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadState {
    #[serde(serialize_with = "serialize_i64_as_string", deserialize_with = "deserialize_i64_from_string_or_number")]
    pub user_id: i64,
    #[serde(serialize_with = "serialize_i64_as_string", deserialize_with = "deserialize_i64_from_string_or_number")]
    pub channel_id: i64,
    #[serde(serialize_with = "serialize_i64_as_string", deserialize_with = "deserialize_i64_from_string_or_number")]
    pub last_read_message_id: i64,
    pub mention_count: i32,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AckRequest {
    pub token: Option<String>,
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub mention_count: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageAckPayload {
    pub channel_id: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayEvent<T> {
    #[serde(rename = "type")]
    pub event_type: String,
    pub version: i32,
    pub guild_id: String,
    pub payload: T,
}

/// Inbound bus envelope for the mention counter (Deserialize only).
#[derive(Debug, Clone, Deserialize)]
pub struct BusEnvelope {
    #[serde(rename = "type", default)]
    pub event_type: String,
    #[serde(default)]
    pub version: i32,
    #[serde(default)]
    pub guild_id: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Authoritative mention payload shape from the API (Issue #121).
/// All fields tolerant: unknown senders must never poison the consumer.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageCreatePayload {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: String,
    #[serde(default)]
    pub author: MessageAuthor,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub mention_roles: Vec<String>,
    #[serde(default)]
    pub mention_everyone: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageAuthor {
    #[serde(default)]
    pub id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageDeletePayload {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub code: i32,
    pub message: String,
}

fn serialize_i64_as_string<S>(val: &i64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&val.to_string())
}

fn deserialize_i64_from_string_or_number<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum IntOrString {
        Int(i64),
        String(String),
    }

    match IntOrString::deserialize(deserializer)? {
        IntOrString::Int(i) => Ok(i),
        IntOrString::String(s) => s.parse::<i64>().map_err(serde::de::Error::custom),
    }
}
