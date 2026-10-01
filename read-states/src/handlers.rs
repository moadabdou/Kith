use std::sync::Arc;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use tracing::error;

use crate::{
    auth::AuthUser,
    db::ScyllaDb,
    model::{AckRequest, ErrorResponse, ReadState},
    nats::NatsPublisher,
    pg::{AccessError, PgDb},
};

#[derive(Clone)]
pub struct AppState {
    pub db: ScyllaDb,
    pub pg: Option<PgDb>,
    pub nats: Option<NatsPublisher>,
    pub jwt_secret: String,
}

pub enum AppError {
    Unauthorized,
    UnknownChannel,
    UnknownMessage,
    MissingAccess,
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, msg) = match self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, 0, "401: Unauthorized"),
            AppError::UnknownChannel => (StatusCode::NOT_FOUND, 10003, "Unknown channel"),
            AppError::UnknownMessage => (StatusCode::NOT_FOUND, 10008, "Unknown message"),
            AppError::MissingAccess => (StatusCode::FORBIDDEN, 50001, "Missing access"),
            AppError::Internal(err) => {
                error!("Internal server error: {:?}", err);
                (StatusCode::INTERNAL_SERVER_ERROR, 0, "500: Internal server error")
            }
        };

        (
            status,
            Json(ErrorResponse {
                code,
                message: msg.to_string(),
            }),
        )
            .into_response()
    }
}

pub async fn ack_message(
    State(state): State<Arc<AppState>>,
    AuthUser(user_id): AuthUser,
    Path((channel_id_str, message_id_str)): Path<(String, String)>,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    let channel_id = channel_id_str
        .parse::<i64>()
        .map_err(|_| AppError::UnknownChannel)?;
    if channel_id <= 0 {
        return Err(AppError::UnknownChannel);
    }

    let message_id = message_id_str
        .parse::<i64>()
        .map_err(|_| AppError::UnknownMessage)?;
    if message_id <= 0 {
        return Err(AppError::UnknownMessage);
    }

    let req: AckRequest = if !body.is_empty() {
        serde_json::from_slice(&body).unwrap_or_default()
    } else {
        AckRequest::default()
    };

    // 1. Verify channel access if PostgreSQL pool is available
    if let Some(pg) = &state.pg {
        if let Err(access_err) = pg.check_channel_access(user_id, channel_id).await {
            return Err(match access_err {
                AccessError::UnknownChannel => AppError::UnknownChannel,
                AccessError::MissingAccess => AppError::MissingAccess,
                AccessError::Internal(e) => AppError::Internal(e),
            });
        }
    }

    // 2. Perform LWT-free point upsert in ScyllaDB
    state
        .db
        .upsert(user_id, channel_id, message_id, req.mention_count)
        .await
        .map_err(AppError::Internal)?;

    // 3. Emit self-targeted MESSAGE_ACK event to user's virtual guild subject
    if let Some(nats) = &state.nats {
        nats.publish_ack(user_id, channel_id, message_id).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_user_read_states(
    State(state): State<Arc<AppState>>,
    AuthUser(user_id): AuthUser,
) -> Result<Json<Vec<ReadState>>, AppError> {
    let states = state
        .db
        .list_by_user(user_id)
        .await
        .map_err(AppError::Internal)?;

    Ok(Json(states))
}

pub async fn get_channel_read_state(
    State(state): State<Arc<AppState>>,
    AuthUser(user_id): AuthUser,
    Path(channel_id_str): Path<String>,
) -> Result<Json<ReadState>, AppError> {
    let channel_id = channel_id_str
        .parse::<i64>()
        .map_err(|_| AppError::UnknownChannel)?;
    if channel_id <= 0 {
        return Err(AppError::UnknownChannel);
    }

    if let Some(pg) = &state.pg {
        if let Err(access_err) = pg.check_channel_access(user_id, channel_id).await {
            return Err(match access_err {
                AccessError::UnknownChannel => AppError::UnknownChannel,
                AccessError::MissingAccess => AppError::MissingAccess,
                AccessError::Internal(e) => AppError::Internal(e),
            });
        }
    }

    let state_opt = state
        .db
        .get(user_id, channel_id)
        .await
        .map_err(AppError::Internal)?;

    let read_state = state_opt.unwrap_or(ReadState {
        user_id,
        channel_id,
        last_read_message_id: 0,
        mention_count: 0,
    });

    Ok(Json(read_state))
}

pub async fn healthz() -> &'static str {
    "OK"
}
