use crate::db;
use crate::watcher::BrowserEvent;
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc::Sender, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Clone)]
struct ApiState {
    sender: Sender<BrowserEvent>,
    seen: Arc<Mutex<HashMap<[u8; 32], i64>>>,
}

#[derive(Deserialize)]
struct EventPayload {
    ts: i64,
    domain: Option<String>,
    title: String,
    #[serde(default)]
    media_playing: bool,
}

pub fn spawn(sender: Sender<BrowserEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("failed to start HTTP runtime");
        runtime.block_on(async move {
            if let Err(error) = serve(sender, stop).await {
                eprintln!("extension API stopped: {error}");
            }
        });
    })
}

async fn serve(sender: Sender<BrowserEvent>, stop: Arc<AtomicBool>) -> Result<(), String> {
    let state = ApiState {
        sender,
        seen: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/event", post(event).options(preflight))
        .route("/register", post(register).options(register_preflight))
        .with_state(state);
    let address = SocketAddr::from(([127, 0, 0, 1], 43110));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| error.to_string())?;

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            while !stop.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
        .await
        .map_err(|error| error.to_string())
}

async fn health(headers: HeaderMap) -> Response {
    let body = Body::from(json!({ "status": "ok" }).to_string());
    match headers.get(header::ORIGIN) {
        Some(_) => match authorize_origin(&headers) {
            Ok(origin) => {
                let mut response = cors_response(StatusCode::OK, body, &origin);
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                response
            }
            Err(status) => status.into_response(),
        },
        None => (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response(),
    }
}

async fn preflight(headers: HeaderMap) -> Response {
    match authorize_origin(&headers) {
        Ok(origin) => cors_response(StatusCode::NO_CONTENT, Body::empty(), &origin),
        Err(status) => status.into_response(),
    }
}

async fn event(
    State(state): State<ApiState>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    let origin = match authorize_origin(&headers) {
        Ok(origin) => origin,
        Err(status) => return status.into_response(),
    };
    if !token_is_valid(&headers) {
        return cors_response(StatusCode::UNAUTHORIZED, Body::empty(), &origin);
    }
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return cors_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, Body::empty(), &origin);
    }

    let bytes = match axum::body::to_bytes(request.into_body(), 4096).await {
        Ok(bytes) => bytes,
        Err(_) => return cors_response(StatusCode::BAD_REQUEST, Body::empty(), &origin),
    };
    let payload: EventPayload = match serde_json::from_slice(&bytes) {
        Ok(payload) => payload,
        Err(_) => return cors_response(StatusCode::BAD_REQUEST, Body::empty(), &origin),
    };
    let domain = payload.domain.unwrap_or_default();
    let received_at = db::now_ms();
    if payload.ts <= 0
        || payload.ts > received_at.saturating_add(60_000)
        || payload.title.is_empty()
        || payload.title.chars().count() > 500
        || domain.chars().count() > 253
    {
        return cors_response(StatusCode::UNPROCESSABLE_ENTITY, Body::empty(), &origin);
    }

    let mut hasher = Sha256::new();
    hasher.update(payload.ts.to_string());
    hasher.update(payload.title.as_bytes());
    hasher.update(domain.as_bytes());
    hasher.update([u8::from(payload.media_playing)]);
    let key: [u8; 32] = hasher.finalize().into();
    let is_new = match state.seen.lock() {
        Ok(mut seen) => {
            seen.retain(|_, seen_at| received_at.saturating_sub(*seen_at) <= 300_000);
            if seen.len() >= 10_000 {
                if let Some(oldest) = seen
                    .iter()
                    .min_by_key(|(_, seen_at)| *seen_at)
                    .map(|(key, _)| *key)
                {
                    seen.remove(&oldest);
                }
            }
            seen.insert(key, received_at).is_none()
        }
        Err(_) => return cors_response(StatusCode::INTERNAL_SERVER_ERROR, Body::empty(), &origin),
    };
    if is_new
        && state
            .sender
            .send(BrowserEvent {
                ts: payload.ts,
                domain,
                title: payload.title,
                media_playing: payload.media_playing,
            })
            .is_err()
    {
        return cors_response(StatusCode::SERVICE_UNAVAILABLE, Body::empty(), &origin);
    }

    cors_response(StatusCode::ACCEPTED, Body::empty(), &origin)
}

fn token_is_valid(headers: &HeaderMap) -> bool {
    let expected =
        match db::open().and_then(|connection| db::setting(&connection, "extension_token")) {
            Ok(Some(token)) if !token.is_empty() => token,
            _ => return false,
        };
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let token = bearer.or_else(|| {
        headers
            .get("x-ttli-token")
            .and_then(|value| value.to_str().ok())
    });
    token == Some(expected.as_str())
}

fn is_valid_extension_id(value: &str) -> bool {
    value.len() == 32
        && value
            .chars()
            .all(|character| ('a'..='p').contains(&character))
}

// Автоподключение: расширение само присылает свой ID при первом контакте.
// Origin (chrome-extension://<id>) выставляет браузер — это источник истины;
// заголовок X-TTLI-Extension-Id обязан совпадать с ним. Токен обязателен.
async fn register(headers: HeaderMap) -> Response {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let deny = |status| cors_response(status, Body::empty(), &origin);

    if !token_is_valid(&headers) {
        return deny(StatusCode::UNAUTHORIZED);
    }
    let Some(extension_id) = origin.strip_prefix("chrome-extension://") else {
        return deny(StatusCode::FORBIDDEN);
    };
    if !is_valid_extension_id(extension_id) {
        return deny(StatusCode::BAD_REQUEST);
    }
    let claimed = headers
        .get("x-ttli-extension-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if claimed != extension_id {
        return deny(StatusCode::FORBIDDEN);
    }
    let browser = headers
        .get("x-ttli-browser")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let key = if browser == "edge" {
        "extension_edge_id"
    } else {
        "extension_chrome_id"
    };
    let connection = match db::open() {
        Ok(connection) => connection,
        Err(_) => return deny(StatusCode::INTERNAL_SERVER_ERROR),
    };
    if db::set_setting(&connection, key, extension_id).is_err() {
        return deny(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let body = Body::from(json!({ "paired": true, "id": extension_id }).to_string());
    let mut response = cors_response(StatusCode::OK, body, &origin);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

// Preflight для /register: origin ещё не привязан, поэтому authorize_origin
// не применяется — только echo CORS-заголовков (preflight не меняет состояние).
async fn register_preflight(headers: HeaderMap) -> Response {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    cors_response(StatusCode::NO_CONTENT, Body::empty(), origin)
}

fn authorize_origin(headers: &HeaderMap) -> Result<String, StatusCode> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let connection = db::open().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let chrome = db::setting(&connection, "extension_chrome_id")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .unwrap_or_default();
    let edge = db::setting(&connection, "extension_edge_id")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .unwrap_or_default();
    let allowed = [chrome, edge]
        .into_iter()
        .filter(|id| !id.is_empty())
        .any(|id| origin == format!("chrome-extension://{id}"));
    if allowed {
        Ok(origin.to_string())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

fn cors_response(status: StatusCode, body: Body, origin: &str) -> Response {
    let mut response = Response::builder()
        .status(status)
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    if let Ok(value) = HeaderValue::from_str(origin) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "authorization, content-type, x-ttli-token, x-ttli-extension-id, x-ttli-browser",
        ),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::is_valid_extension_id;

    #[test]
    fn validates_chromium_extension_ids() {
        assert!(is_valid_extension_id("abcdefghijklmnopabcdefghijklmnop"));
        assert!(!is_valid_extension_id("abcdefghijklmnopabcdefghijklmno"));
        assert!(!is_valid_extension_id("abcdefghijklmnopabcdefghijklmnoq"));
        assert!(!is_valid_extension_id("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"));
    }
}
