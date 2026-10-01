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
