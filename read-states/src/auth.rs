use std::sync::Arc;
use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

use crate::handlers::AppState;
use crate::model::ErrorResponse;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    #[serde(default)]
    pub iat: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
pub struct AuthUser(pub i64);

pub struct AuthError(pub StatusCode, pub &'static str);

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let body = Json(ErrorResponse {
            code: 0,
            message: format!("{}: {}", self.0.as_u16(), self.1),
        });
        (self.0, body).into_response()
    }
}

pub fn verify_token(token: &str, secret: &str) -> Result<i64, AuthError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AuthError(StatusCode::UNAUTHORIZED, "Unauthorized"))?;

    token_data
        .claims
        .sub
        .parse::<i64>()
        .map_err(|_| AuthError(StatusCode::UNAUTHORIZED, "Unauthorized"))
}

impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok());

        let token = match auth_header {
            Some(header) if header.starts_with("Bearer ") => &header[7..],
            _ => return Err(AuthError(StatusCode::UNAUTHORIZED, "Unauthorized")),
        };

        let user_id = verify_token(token, &state.jwt_secret)?;
        Ok(AuthUser(user_id))
    }
}
